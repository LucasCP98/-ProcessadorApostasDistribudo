import { Money } from '../../shared/domain/value-objects/money.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry.entity.js';

describe('WalletLedgerEntry', () => {
  it('accepts a credit whose before and after balances reconcile', () => {
    const entry = WalletLedgerEntry.create({
      id: 'ledger-id',
      walletId: 'wallet-id',
      transactionId: 'transaction-id',
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '10.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '35.00', currency: 'BRL' }),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects arithmetic mismatch and currency mismatch', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-id',
        walletId: 'wallet-id',
        transactionId: 'transaction-id',
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '5.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '10.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '10.00', currency: 'BRL' }),
      }),
    ).toThrow('arithmetic check failed');

    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-id',
        walletId: 'wallet-id',
        transactionId: 'transaction-id',
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '5.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '10.00', currency: 'USD' }),
        balanceAfter: Money.from({ amount: '15.00', currency: 'BRL' }),
      }),
    ).toThrow('Currency mismatch');
  });
});
