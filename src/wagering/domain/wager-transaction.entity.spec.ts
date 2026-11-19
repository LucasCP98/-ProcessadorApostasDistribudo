import { Money } from '../../shared/domain/value-objects/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.entity.js';
import { LedgerDirection } from './wallet-ledger-entry.entity.js';

function createTransaction(
  kind: WagerTransactionKind,
  reference?: string,
  money = Money.from({ amount: '10.00', currency: 'BRL' }),
) {
  return WagerTransaction.create({
    id: 'transaction-id',
    providerId: 'provider',
    externalTransactionId: 'external-id',
    idempotencyKey: 'key',
    payloadHash: 'hash',
    walletId: 'wallet-id',
    playerId: 'player-id',
    roundId: 'round-id',
    gameId: 'game-id',
    kind,
    money,
    referenceExternalTransactionId: reference,
  });
}

describe('WagerTransaction', () => {
  it('rejects zero-value and opening transactions from external creation', () => {
    expect(() => createTransaction(WagerTransactionKind.Opening)).toThrow();
    expect(() =>
      createTransaction(WagerTransactionKind.Bet, undefined, Money.zero('BRL')),
    ).toThrow();
  });

  it('requires a reference for reversal transactions', () => {
    expect(() => createTransaction(WagerTransactionKind.Refund)).toThrow();
    expect(() => createTransaction(WagerTransactionKind.Rollback)).toThrow();
  });

  it('computes rollback direction from the referenced transaction', () => {
    const rollback = createTransaction(
      WagerTransactionKind.Rollback,
      'bet-external-id',
    );
    const bet = WagerTransaction.rehydrate({
      id: 'bet-id',
      providerId: 'provider',
      externalTransactionId: 'bet-external-id',
      idempotencyKey: 'bet-key',
      payloadHash: 'bet-hash',
      walletId: 'wallet-id',
      playerId: 'player-id',
      roundId: 'round-id',
      gameId: 'game-id',
      kind: WagerTransactionKind.Bet,
      amount: '10.00',
      currency: 'BRL',
      createdAt: new Date(),
      status: WagerTransactionStatus.Processed,
    });

    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });
});
