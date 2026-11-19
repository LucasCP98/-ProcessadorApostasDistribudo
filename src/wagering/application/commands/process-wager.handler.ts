import { randomUUID } from 'node:crypto';
import { EntityManager, LockMode } from '@mikro-orm/core';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Money } from '../../../shared/domain/value-objects/money.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.entity.js';
import { Wallet } from '../../domain/wallet.aggregate.js';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.entity.js';
import { InboxMessageEntity } from '../../../shared/infrastructure/database/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from '../../../shared/infrastructure/database/entities/outbox-message.entity.js';
import { wagerTransactionResults } from '../../../shared/infrastructure/observability/metrics-registry.js';
import { WalletEntity } from '../../infrastructure/persistence/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../infrastructure/persistence/entities/wager-transaction.entity.js';

export interface ProcessWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: { amount: string; currency: string };
  correlationId?: string;
  causationId?: string;
  referenceExternalTransactionId?: string;
  inboxMessage?: { consumerName: string; messageId: string };
}

export interface ProcessWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessWagerHandler {
  constructor(private readonly em: EntityManager) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerResult> {
    const money = Money.from(command.money);
    const result = await this.em.transactional(async (em) => {
      await em
        .getConnection()
        .execute(
          'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
          [`wager-idempotency:${command.idempotencyKey}`],
          'all',
          em.getTransactionContext(),
        );
      await em
        .getConnection()
        .execute(
          'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
          [
            `wager-external:${command.providerId}:${command.externalTransactionId}`,
          ],
          'all',
          em.getTransactionContext(),
        );

      if (command.inboxMessage) {
        const inbox = await em.findOne(
          InboxMessageEntity,
          command.inboxMessage,
        );
        if (inbox) {
          if (inbox.payloadHash !== command.payloadHash) {
            throw new ConflictException(
              'SQS message ID reused with a different payload.',
            );
          }
          const transaction = await this.findExistingTransaction(em, command);
          if (!transaction) {
            throw new Error(
              'Inbox record exists without its corresponding wager transaction.',
            );
          }
          return this.toReplayResult(transaction);
        }
      }

      const existing = await this.findExistingTransaction(em, command);
      if (existing) {
        this.assertSamePayload(existing, command.payloadHash);
        await this.recordInbox(em, command);
        return this.toReplayResult(existing);
      }

      const walletEntity = await em.findOne(
        WalletEntity,
        { id: command.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!walletEntity || walletEntity.playerId !== command.playerId) {
        throw new NotFoundException('Wallet not found for player.');
      }

      const afterLock = await this.findExistingTransaction(em, command);
      if (afterLock) {
        this.assertSamePayload(afterLock, command.payloadHash);
        await this.recordInbox(em, command);
        return this.toReplayResult(afterLock);
      }

      const wallet = this.rehydrateWallet(walletEntity);
      const transaction = WagerTransaction.create({
        ...command,
        id: randomUUID(),
        money,
      });
      const entity = this.createTransactionEntity(em, transaction, money);
      entity.correlationId = command.correlationId ?? command.payloadHash;
      entity.causationId =
        command.causationId ?? command.inboxMessage?.messageId;
      const balanceBefore = wallet.balance;

      if (money.currency !== wallet.currency) {
        transaction.reject(FailureCode.CurrencyMismatch);
        entity.status = transaction.status;
        entity.failureCode = transaction.failureCode;
        entity.processedAt = transaction.processedAt;
        entity.resultingBalance = balanceBefore.toJSON().amount;
        entity.resultingCurrency = wallet.currency;
        await this.persistResult(em, entity, command, true, wallet.version);
        return this.toResult(entity, false);
      }

      let referenceEntity: WagerTransactionEntity | null = null;
      if (transaction.requiresReference()) {
        referenceEntity = await em.findOne(
          WagerTransactionEntity,
          {
            providerId: command.providerId,
            externalTransactionId: command.referenceExternalTransactionId!,
          },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (!referenceEntity) {
          transaction.markPendingReference();
          entity.status = transaction.status;
          entity.resultingBalance = balanceBefore.toJSON().amount;
          entity.resultingCurrency = wallet.currency;
          await this.persistResult(em, entity, command, false, wallet.version);
          return this.toResult(entity, false);
        }
        if (
          referenceEntity.status === WagerTransactionStatus.Pending ||
          referenceEntity.status === WagerTransactionStatus.PendingReference
        ) {
          transaction.markPendingReference();
          entity.status = transaction.status;
          entity.referenceTransactionId = referenceEntity.id;
          entity.resultingBalance = balanceBefore.toJSON().amount;
          entity.resultingCurrency = wallet.currency;
          await this.persistResult(em, entity, command, false, wallet.version);
          return this.toResult(entity, false);
        }
      }

      const referenceFailure = await this.validateReference(
        em,
        transaction,
        entity,
        referenceEntity,
        wallet,
      );
      if (referenceFailure) {
        transaction.reject(referenceFailure);
        entity.status = transaction.status;
        entity.failureCode = transaction.failureCode;
        entity.referenceTransactionId = referenceEntity?.id;
        entity.processedAt = transaction.processedAt;
        entity.resultingBalance = balanceBefore.toJSON().amount;
        entity.resultingCurrency = wallet.currency;
        await this.persistResult(em, entity, command, true, wallet.version);
        return this.toResult(entity, false);
      }

      const reference = referenceEntity
        ? this.rehydrateTransaction(referenceEntity)
        : undefined;
      const direction = transaction.ledgerDirectionFor(reference);

      if (direction === 'DEBIT' && wallet.balance.isLessThan(money)) {
        transaction.reject(FailureCode.InsufficientFunds);
        entity.status = transaction.status;
        entity.failureCode = transaction.failureCode;
        entity.referenceTransactionId = referenceEntity?.id;
        entity.processedAt = transaction.processedAt;
        entity.resultingBalance = balanceBefore.toJSON().amount;
        entity.resultingCurrency = wallet.currency;
        await this.persistResult(em, entity, command, true, wallet.version);
        return this.toResult(entity, false);
      }
      if (
        direction === 'CREDIT' &&
        Money.max(wallet.currency).subtract(wallet.balance).isLessThan(money)
      ) {
        transaction.reject(FailureCode.InvalidAmount);
        entity.status = transaction.status;
        entity.failureCode = transaction.failureCode;
        entity.referenceTransactionId = referenceEntity?.id;
        entity.processedAt = transaction.processedAt;
        entity.resultingBalance = balanceBefore.toJSON().amount;
        entity.resultingCurrency = wallet.currency;
        await this.persistResult(em, entity, command, true, wallet.version);
        return this.toResult(entity, false);
      }

      if (direction === 'DEBIT') {
        wallet.debit(money);
      } else if (direction === 'CREDIT') {
        wallet.credit(money);
      }

      transaction.markProcessed(referenceEntity?.id);
      entity.status = transaction.status;
      entity.referenceTransactionId =
        transaction.referenceTransactionId ?? referenceEntity?.id;
      entity.processedAt = transaction.processedAt;
      entity.resultingBalance = wallet.balance.toJSON().amount;
      entity.resultingCurrency = wallet.currency;

      const walletChanged = direction !== undefined;
      let ledgerEntry: WalletLedgerEntry | null = null;
      if (walletChanged) {
        walletEntity.balance = wallet.balance.toJSON().amount;
        walletEntity.version = wallet.version;
        walletEntity.updatedAt = wallet.updatedAt;
        const ledger = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: transaction.id,
          direction,
          money,
          balanceBefore,
          balanceAfter: wallet.balance,
        });
        ledgerEntry = ledger;
        em.persist(walletEntity);
      }

      await this.persistResult(em, entity, command, true, wallet.version);
      if (ledgerEntry) {
        await this.insertLedger(em, ledgerEntry);
      }
      return this.toResult(entity, false);
    });
    if (!result.idempotentReplay) {
      wagerTransactionResults.labels(command.kind, result.status).inc();
    }
    return result;
  }

  async retryPendingReferences(limit = 100): Promise<void> {
    const em = this.em.fork();
    const pending = await em.find(
      WagerTransactionEntity,
      {
        status: WagerTransactionStatus.PendingReference,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }],
      },
      { orderBy: { createdAt: 'ASC' }, limit },
    );

    for (const candidate of pending) {
      await this.retryPendingReference(em, candidate.id);
    }
  }

  private async retryPendingReference(
    em: EntityManager,
    transactionId: string,
  ): Promise<void> {
    await em.transactional(async (em) => {
      const observed = await em.findOne(WagerTransactionEntity, {
        id: transactionId,
      });
      if (
        !observed ||
        observed.status !== WagerTransactionStatus.PendingReference
      ) {
        return;
      }

      const walletEntity = await em.findOne(
        WalletEntity,
        { id: observed.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!walletEntity) {
        throw new Error(`Pending transaction ${transactionId} has no wallet.`);
      }
      const entity = await em.findOne(
        WagerTransactionEntity,
        { id: transactionId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (
        !entity ||
        entity.status !== WagerTransactionStatus.PendingReference
      ) {
        return;
      }
      if (entity.nextAttemptAt && entity.nextAttemptAt > new Date()) {
        return;
      }
      const transaction = this.rehydrateTransaction(entity);
      const referenceEntity = await em.findOne(
        WagerTransactionEntity,
        {
          providerId: entity.providerId,
          externalTransactionId: entity.referenceExternalTransactionId!,
        },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (
        !referenceEntity ||
        referenceEntity.status === WagerTransactionStatus.Pending ||
        referenceEntity.status === WagerTransactionStatus.PendingReference
      ) {
        entity.attempts += 1;
        entity.nextAttemptAt = new Date(
          Date.now() + Math.min(2 ** entity.attempts, 300) * 1000,
        );
        em.persist(entity);
        await em.flush();
        return;
      }

      const wallet = this.rehydrateWallet(walletEntity);
      const balanceBefore = wallet.balance;
      const failure = await this.validateReference(
        em,
        transaction,
        entity,
        referenceEntity,
        wallet,
      );
      if (failure) {
        transaction.reject(failure);
      } else {
        const reference = this.rehydrateTransaction(referenceEntity);
        const direction = transaction.ledgerDirectionFor(reference);
        const money = transaction.money;
        if (direction === 'DEBIT' && wallet.balance.isLessThan(money)) {
          transaction.reject(FailureCode.InsufficientFunds);
        } else if (
          direction === 'CREDIT' &&
          Money.max(wallet.currency).subtract(wallet.balance).isLessThan(money)
        ) {
          transaction.reject(FailureCode.InvalidAmount);
        } else {
          if (direction === 'DEBIT') wallet.debit(money);
          if (direction === 'CREDIT') wallet.credit(money);
          transaction.markProcessed(referenceEntity.id);
          if (direction) {
            walletEntity.balance = wallet.balance.toJSON().amount;
            walletEntity.version = wallet.version;
            walletEntity.updatedAt = wallet.updatedAt;
            em.persist(walletEntity);
            const ledger = WalletLedgerEntry.create({
              id: randomUUID(),
              walletId: wallet.id,
              transactionId: transaction.id,
              direction,
              money,
              balanceBefore,
              balanceAfter: wallet.balance,
            });
            await this.insertLedger(em, ledger);
          }
        }
      }

      entity.status = transaction.status;
      entity.referenceTransactionId = transaction.referenceTransactionId;
      entity.failureCode = transaction.failureCode;
      entity.processedAt = transaction.processedAt;
      entity.resultingBalance = wallet.balance.toJSON().amount;
      entity.resultingCurrency = wallet.currency;
      entity.nextAttemptAt = null;
      entity.correlationId ??= entity.payloadHash;
      em.persist(entity);
      em.persist(
        em.create(OutboxMessageEntity, {
          id: randomUUID(),
          aggregateId: wallet.id,
          eventType: 'wager.transaction.processed',
          correlationId: entity.correlationId,
          causationId: entity.causationId,
          version: wallet.version,
          payload: {
            transactionId: entity.id,
            walletId: entity.walletId,
            providerId: entity.providerId,
            kind: entity.kind,
            status: entity.status,
            money: { amount: entity.amount, currency: entity.currency },
            balance: {
              amount: entity.resultingBalance,
              currency: entity.resultingCurrency,
            },
          },
          occurredAt: new Date(),
          attempts: 0,
        }),
      );
      await em.flush();
    });
  }

  private async findExistingTransaction(
    em: EntityManager,
    command: ProcessWagerCommand,
  ): Promise<WagerTransactionEntity | null> {
    const byIdempotency = await em.findOne(WagerTransactionEntity, {
      idempotencyKey: command.idempotencyKey,
    });
    if (byIdempotency) return byIdempotency;

    return em.findOne(WagerTransactionEntity, {
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
    });
  }

  private assertSamePayload(
    transaction: WagerTransactionEntity,
    payloadHash: string,
  ): void {
    if (transaction.payloadHash !== payloadHash) {
      throw new ConflictException(
        'Transaction identity reused with a different payload.',
      );
    }
  }

  private rehydrateWallet(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({
        amount: entity.balance,
        currency: entity.currency,
      }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  private rehydrateTransaction(
    entity: WagerTransactionEntity,
  ): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind as WagerTransactionKind,
      amount: entity.amount,
      currency: entity.currency,
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      referenceTransactionId: entity.referenceTransactionId,
      createdAt: entity.createdAt,
      status: entity.status as WagerTransactionStatus,
      failureCode: entity.failureCode as FailureCode | undefined,
      processedAt: entity.processedAt,
    });
  }

  private createTransactionEntity(
    em: EntityManager,
    transaction: WagerTransaction,
    money: Money,
  ): WagerTransactionEntity {
    return em.create(WagerTransactionEntity, {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: money.toJSON().amount,
      currency: money.currency,
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId,
      status: transaction.status,
      createdAt: transaction.createdAt,
      resultingBalance: money.toJSON().amount,
      resultingCurrency: money.currency,
      attempts: 0,
    });
  }

  private async validateReference(
    em: EntityManager,
    transaction: WagerTransaction,
    entity: WagerTransactionEntity,
    referenceEntity: WagerTransactionEntity | null,
    wallet: Wallet,
  ): Promise<FailureCode | undefined> {
    if (!transaction.requiresReference()) return undefined;
    if (!referenceEntity) return FailureCode.ReferenceNotFound;
    if (
      referenceEntity.status !== WagerTransactionStatus.Processed ||
      referenceEntity.walletId !== wallet.id ||
      referenceEntity.playerId !== wallet.playerId ||
      referenceEntity.currency !== wallet.currency
    ) {
      return FailureCode.InvalidReferenceType;
    }

    const reference = this.rehydrateTransaction(referenceEntity);
    const allowedKinds =
      transaction.kind === WagerTransactionKind.Refund
        ? [WagerTransactionKind.Bet]
        : [
            WagerTransactionKind.Bet,
            WagerTransactionKind.Win,
            WagerTransactionKind.Refund,
          ];
    if (!allowedKinds.includes(reference.kind)) {
      return FailureCode.InvalidReferenceType;
    }

    if (transaction.kind === WagerTransactionKind.Rollback) {
      if (!transaction.money.equals(reference.money)) {
        return FailureCode.InvalidAmount;
      }
      const priorRollback = await em.findOne(WagerTransactionEntity, {
        providerId: transaction.providerId,
        referenceTransactionId: referenceEntity.id,
        kind: WagerTransactionKind.Rollback,
        status: WagerTransactionStatus.Processed,
      });
      if (priorRollback) return FailureCode.AlreadyReversed;
      if (reference.kind === WagerTransactionKind.Bet) {
        const netRefunded = await this.getNetRefundedAmount(
          em,
          transaction.providerId,
          referenceEntity.id,
          reference.money.currency,
        );
        if (!netRefunded.isZero()) return FailureCode.AlreadyReversed;
      }
    } else {
      const priorRollback = await em.findOne(WagerTransactionEntity, {
        providerId: transaction.providerId,
        referenceTransactionId: referenceEntity.id,
        kind: WagerTransactionKind.Rollback,
        status: WagerTransactionStatus.Processed,
      });
      if (priorRollback) return FailureCode.AlreadyReversed;
      const refunded = await this.getNetRefundedAmount(
        em,
        transaction.providerId,
        referenceEntity.id,
        reference.money.currency,
      );
      if (reference.money.isLessThan(refunded.add(transaction.money))) {
        return FailureCode.InvalidAmount;
      }
    }
    entity.referenceTransactionId = referenceEntity.id;
    return undefined;
  }

  private async getNetRefundedAmount(
    em: EntityManager,
    providerId: string,
    referenceTransactionId: string,
    currency: string,
  ): Promise<Money> {
    const refunds = await em.find(WagerTransactionEntity, {
      providerId,
      referenceTransactionId,
      kind: WagerTransactionKind.Refund,
      status: WagerTransactionStatus.Processed,
    });
    let net = Money.zero(currency);
    for (const refund of refunds) {
      net = net.add(Money.from({ amount: refund.amount, currency }));
      const rollback = await em.findOne(WagerTransactionEntity, {
        providerId,
        referenceTransactionId: refund.id,
        kind: WagerTransactionKind.Rollback,
        status: WagerTransactionStatus.Processed,
      });
      if (rollback) {
        net = net.subtract(Money.from({ amount: rollback.amount, currency }));
      }
    }
    return net;
  }

  private async persistResult(
    em: EntityManager,
    entity: WagerTransactionEntity,
    command: ProcessWagerCommand,
    publishEvent: boolean,
    version: number,
  ): Promise<void> {
    em.persist(entity);
    await this.recordInbox(em, command);

    if (publishEvent) {
      em.persist(
        em.create(OutboxMessageEntity, {
          id: randomUUID(),
          aggregateId: entity.walletId,
          eventType: 'wager.transaction.processed',
          correlationId: entity.correlationId ?? command.payloadHash,
          causationId:
            entity.causationId ??
            command.causationId ??
            command.inboxMessage?.messageId,
          version,
          payload: {
            transactionId: entity.id,
            walletId: entity.walletId,
            providerId: entity.providerId,
            kind: entity.kind,
            status: entity.status,
            money: { amount: entity.amount, currency: entity.currency },
            balance: {
              amount: entity.resultingBalance,
              currency: entity.resultingCurrency,
            },
          },
          occurredAt: new Date(),
          attempts: 0,
        }),
      );
    }
    await em.flush();
  }

  private async insertLedger(
    em: EntityManager,
    ledger: WalletLedgerEntry,
  ): Promise<void> {
    await em.getConnection().execute(
      `
        INSERT INTO wallet_ledger_entries (
          id, wallet_id, transaction_id, direction, amount, currency,
          balance_before, balance_after, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        ledger.id,
        ledger.walletId,
        ledger.transactionId,
        ledger.direction,
        ledger.money.toJSON().amount,
        ledger.money.currency,
        ledger.balanceBefore.toJSON().amount,
        ledger.balanceAfter.toJSON().amount,
        ledger.createdAt,
      ],
      'run',
      em.getTransactionContext(),
    );
  }

  private async recordInbox(
    em: EntityManager,
    command: ProcessWagerCommand,
  ): Promise<void> {
    if (!command.inboxMessage) return;
    const existing = await em.findOne(InboxMessageEntity, command.inboxMessage);
    if (existing) {
      if (existing.payloadHash !== command.payloadHash) {
        throw new ConflictException(
          'SQS message ID reused with a different payload.',
        );
      }
      return;
    }
    em.persist(
      em.create(InboxMessageEntity, {
        consumerName: command.inboxMessage.consumerName,
        messageId: command.inboxMessage.messageId,
        payloadHash: command.payloadHash,
        receivedAt: new Date(),
        processedAt: new Date(),
      }),
    );
  }

  private toReplayResult(entity: WagerTransactionEntity): ProcessWagerResult {
    return this.toResult(entity, true);
  }

  private toResult(
    entity: WagerTransactionEntity,
    idempotentReplay: boolean,
  ): ProcessWagerResult {
    return {
      transactionId: entity.id,
      status: entity.status as WagerTransactionStatus,
      balance: {
        amount: entity.resultingBalance,
        currency: entity.resultingCurrency,
      },
      idempotentReplay,
    };
  }
}
