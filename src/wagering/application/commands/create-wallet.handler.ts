import { randomUUID } from 'node:crypto';
import { EntityManager } from '@mikro-orm/core';
import { ConflictException, Injectable } from '@nestjs/common';
import { Money } from '../../../shared/domain/value-objects/money.js';
import { OutboxMessageEntity } from '../../../shared/infrastructure/database/entities/outbox-message.entity.js';
import { walletsCreated } from '../../../shared/infrastructure/observability/metrics-registry.js';
import {
  WalletLedgerEntry,
  LedgerDirection,
} from '../../domain/wallet-ledger-entry.entity.js';
import { Wallet } from '../../domain/wallet.aggregate.js';
import { WagerTransaction } from '../../domain/wager-transaction.entity.js';
import { WagerTransactionEntity } from '../../infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletEntity } from '../../infrastructure/persistence/entities/wallet.entity.js';

@Injectable()
export class CreateWalletHandler {
  constructor(private readonly em: EntityManager) {}

  async execute(command: {
    playerId: string;
    initialBalance: string;
    currency: string;
    correlationId?: string;
    causationId?: string;
  }): Promise<{
    walletId: string;
    playerId: string;
    balance: { amount: string; currency: string };
  }> {
    const money = Money.from({
      amount: command.initialBalance,
      currency: command.currency,
    });

    const result = await this.em.transactional(async (em) => {
      await em
        .getConnection()
        .execute(
          'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
          [`wallet:${command.playerId}:${money.currency}`],
          'all',
          em.getTransactionContext(),
        );
      const existing = await em.findOne(WalletEntity, {
        playerId: command.playerId,
        currency: money.currency,
      });
      if (existing) {
        throw new ConflictException(
          'A wallet already exists for this player and currency.',
        );
      }

      const wallet = Wallet.open({
        id: randomUUID(),
        playerId: command.playerId,
        initialBalance: money,
      });
      const walletEntity = em.create(WalletEntity, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });
      em.persist(walletEntity);
      await em.flush();

      if (money.isPositive()) {
        const opening = WagerTransaction.createOpening({
          id: randomUUID(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          money,
        });
        opening.markProcessed(undefined);

        const openingEntity = em.create(WagerTransactionEntity, {
          id: opening.id,
          providerId: opening.providerId,
          externalTransactionId: opening.externalTransactionId,
          idempotencyKey: opening.idempotencyKey,
          payloadHash: opening.payloadHash,
          walletId: opening.walletId,
          playerId: opening.playerId,
          roundId: opening.roundId,
          gameId: opening.gameId,
          kind: opening.kind,
          amount: money.toJSON().amount,
          currency: money.currency,
          status: opening.status,
          processedAt: opening.processedAt,
          createdAt: opening.createdAt,
          resultingBalance: money.toJSON().amount,
          resultingCurrency: money.currency,
          attempts: 0,
        });
        em.persist(openingEntity);
        await em.flush();

        const ledger = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: opening.id,
          direction: LedgerDirection.Credit,
          money,
          balanceBefore: Money.zero(money.currency),
          balanceAfter: money,
        });
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
        em.persist(
          em.create(OutboxMessageEntity, {
            id: randomUUID(),
            aggregateId: wallet.id,
            eventType: 'wallet.opened',
            correlationId: command.correlationId ?? wallet.id,
            causationId: command.causationId,
            version: wallet.version,
            payload: {
              walletId: wallet.id,
              playerId: wallet.playerId,
              initialBalance: money.toJSON(),
              currency: money.currency,
            },
            occurredAt: new Date(),
            attempts: 0,
          }),
        );
      }

      await em.flush();
      return {
        walletId: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
      };
    });
    walletsCreated.labels(money.currency).inc();
    return result;
  }
}
