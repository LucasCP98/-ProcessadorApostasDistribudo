import { Decimal } from 'decimal.js';
import { EntityManager } from '@mikro-orm/core';
import { Injectable, NotFoundException } from '@nestjs/common';
import { WalletLedgerEntity } from '../../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletEntity } from '../../infrastructure/persistence/entities/wallet.entity.js';

interface ReconciliationRow {
  wallet_id: string;
  player_id: string;
  currency: string;
  wallet_balance: string;
  ledger_balance: string;
  reconciled: boolean;
}

interface WalletReconciliationRow {
  wallet_id: string;
  currency: string;
  wallet_balance: string;
  ledger_balance: string;
  checked_entries: number;
}

@Injectable()
export class WageringQueriesHandler {
  constructor(private readonly em: EntityManager) {}

  async getWallet(walletId: string) {
    const wallet = await this.em.findOne(WalletEntity, { id: walletId });
    if (!wallet) throw new NotFoundException('Wallet not found.');
    return {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  async getTransaction(transactionId: string) {
    const transaction = await this.em.findOne(WagerTransactionEntity, {
      id: transactionId,
    });
    if (!transaction) throw new NotFoundException('Transaction not found.');
    return transaction;
  }

  async getLedger(walletId: string, limit: number, offset: number) {
    const wallet = await this.em.findOne(WalletEntity, { id: walletId });
    if (!wallet) throw new NotFoundException('Wallet not found.');
    const [entries, total] = await this.em.findAndCount(
      WalletLedgerEntity,
      { walletId },
      {
        orderBy: { createdAt: 'ASC', id: 'ASC' },
        limit,
        offset,
      },
    );
    return { walletId, total, limit, offset, entries };
  }

  async reconcile(walletId?: string) {
    const rows: ReconciliationRow[] = await this.em.getConnection().execute(
      `
        SELECT
          w.id AS wallet_id,
          w.player_id,
          w.currency,
          w.balance::text AS wallet_balance,
          COALESCE(SUM(
            CASE WHEN l.direction = 'CREDIT' THEN l.amount
                 WHEN l.direction = 'DEBIT' THEN -l.amount
                 ELSE 0 END
          ), 0)::text AS ledger_balance,
          w.balance = COALESCE(SUM(
            CASE WHEN l.direction = 'CREDIT' THEN l.amount
                 WHEN l.direction = 'DEBIT' THEN -l.amount
                 ELSE 0 END
          ), 0) AS reconciled
        FROM wallets w
        LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE (? IS NULL OR w.id = ?)
        GROUP BY w.id
        ORDER BY w.id
      `,
      [walletId ?? null, walletId ?? null],
    );
    return {
      reconciled: rows.every((row) => row.reconciled),
      wallets: rows.map((row) => ({
        walletId: row.wallet_id,
        playerId: row.player_id,
        currency: row.currency,
        walletBalance: row.wallet_balance,
        ledgerBalance: row.ledger_balance,
        reconciled: row.reconciled,
      })),
    };
  }

  async reconcileWallet(walletId: string) {
    const rows: WalletReconciliationRow[] = await this.em
      .getConnection()
      .execute(
        `
          SELECT
            w.id AS wallet_id,
            w.currency,
            w.balance::text AS wallet_balance,
            COALESCE(SUM(
              CASE WHEN l.direction = 'CREDIT' THEN l.amount
                   WHEN l.direction = 'DEBIT' THEN -l.amount
                   ELSE 0 END
            ), 0)::text AS ledger_balance,
            COUNT(l.id)::int AS checked_entries
          FROM wallets w
          LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
          WHERE w.id = ?
          GROUP BY w.id
        `,
        [walletId],
      );
    const row = rows[0];
    if (!row) throw new NotFoundException('Wallet not found.');

    const storedBalance = new Decimal(row.wallet_balance);
    const calculatedBalance = new Decimal(row.ledger_balance);
    const currency = row.currency.toUpperCase();
    return {
      walletId: row.wallet_id,
      storedBalance: { amount: storedBalance.toFixed(2), currency },
      calculatedBalance: {
        amount: calculatedBalance.toFixed(2),
        currency,
      },
      difference: {
        amount: storedBalance.minus(calculatedBalance).toFixed(2),
        currency,
      },
      consistent: storedBalance.equals(calculatedBalance),
      checkedEntries: Number(row.checked_entries),
    };
  }
}
