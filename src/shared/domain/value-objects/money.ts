import { Decimal } from 'decimal.js';

export interface MoneyProps {
    amount: string;   // decimal string, ex.: "25.00"
    currency: string; // ISO-4217
}

export class Money {
    private static readonly maxValue = new Decimal('9999999999999.99');

    private constructor(
        private readonly value: Decimal,
        public readonly currency: string,
    ) { }

    static from(props: MoneyProps): Money {
        if (!props || typeof props.amount !== 'string' || typeof props.currency !== 'string') {
            throw new Error('Invalid money props format.');
        }

        const { amount, currency } = props;

        if (!/^\d{1,13}(?:\.\d{1,2})?$/.test(amount)) {
            throw new Error(`Invalid decimal amount format: "${amount}"`);
        }

        const decimalValue = new Decimal(amount);

        if (!decimalValue.isFinite()) {
            throw new Error('Money amount must be finite.');
        }

        const decimalPlaces = decimalValue.decimalPlaces();
        if (decimalPlaces > 2) {
            throw new Error(`Money amount cannot exceed 2 decimal places: "${amount}"`);
        }
        if (decimalValue.greaterThan(Money.maxValue)) {
            throw new Error('Money amount exceeds the supported precision.');
        }

        if (!/^[A-Za-z]{3}$/.test(currency)) {
            throw new Error(`Invalid currency code: "${currency}"`);
        }

        return new Money(decimalValue.toDecimalPlaces(2), currency.toUpperCase());
    }

    static zero(currency: string): Money {
        if (!/^[A-Za-z]{3}$/.test(currency)) {
            throw new Error(`Invalid currency code: "${currency}"`);
        }
        return new Money(new Decimal('0.00'), currency.toUpperCase());
    }

    static max(currency: string): Money {
        if (!/^[A-Za-z]{3}$/.test(currency)) {
            throw new Error(`Invalid currency code: "${currency}"`);
        }
        return new Money(Money.maxValue, currency.toUpperCase());
    }

    add(other: Money): Money {
        this.assertSameCurrency(other);
        const sum = this.value.plus(other.value);
        if (sum.greaterThan(Money.maxValue)) {
            throw new Error('Money operation exceeds the supported precision.');
        }
        return new Money(sum, this.currency);
    }

    subtract(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.value.minus(other.value), this.currency);
    }

    negate(): Money {
        return new Money(this.value.negated(), this.currency);
    }

    isZero(): boolean {
        return this.value.isZero();
    }

    isPositive(): boolean {
        return this.value.isPositive() && !this.value.isZero();
    }

    isNegative(): boolean {
        return this.value.isNegative();
    }

    isLessThan(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.value.lt(other.value);
    }

    equals(other: Money): boolean {
        return this.currency === other.currency && this.value.equals(other.value);
    }

    toJSON(): MoneyProps {
        return {
            amount: this.value.toFixed(2),
            currency: this.currency,
        };
    }

    toString(): string {
        return `${this.value.toFixed(2)} ${this.currency}`;
    }

    private assertSameCurrency(other: Money): void {
        if (this.currency !== other.currency) {
            throw new Error(`Currency mismatch: cannot operate between ${this.currency} and ${other.currency}`);
        }
    }
}