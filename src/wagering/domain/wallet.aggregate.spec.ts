import { Money } from '../../shared/domain/value-objects/money.js';
import { Wallet } from './wallet.aggregate.js';

describe('Wallet', () => {
  it('updates balance and version when debiting and crediting', () => {
    const wallet = Wallet.open({
      id: 'wallet-id',
      playerId: 'player-id',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    wallet.debit(Money.from({ amount: '25.00', currency: 'BRL' }));
    expect(wallet.balance.toJSON()).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(2);

    wallet.credit(Money.from({ amount: '10.00', currency: 'BRL' }));
    expect(wallet.balance.toJSON()).toEqual({
      amount: '85.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(3);
  });

  it('rejects overspending, zero amounts, and currency mismatches without mutation', () => {
    const wallet = Wallet.open({
      id: 'wallet-id',
      playerId: 'player-id',
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    expect(() =>
      wallet.debit(Money.from({ amount: '10.01', currency: 'BRL' })),
    ).toThrow('Insufficient funds');
    expect(() => wallet.credit(Money.zero('BRL'))).toThrow(
      'Wallet operations require a positive amount',
    );
    expect(() =>
      wallet.credit(Money.from({ amount: '1.00', currency: 'USD' })),
    ).toThrow('does not match');
    expect(wallet.balance.toJSON()).toEqual({
      amount: '10.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
  });
});
