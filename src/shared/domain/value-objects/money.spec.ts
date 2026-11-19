import { Money } from './money.js';

describe('Money', () => {
  it('normalizes currency and formats values to two decimal places', () => {
    expect(Money.from({ amount: '12.5', currency: 'brl' }).toJSON()).toEqual({
      amount: '12.50',
      currency: 'BRL',
    });
  });

  it.each(['-1.00', '1e2', '1.001', 'NaN'])(
    'rejects invalid monetary amount %s',
    (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow();
    },
  );

  it('rejects invalid currency codes', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'US' })).toThrow();
  });
});
