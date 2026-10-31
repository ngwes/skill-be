// tiny-money: amounts are whole cents, so adding and splitting them never drifts.

export type Currency = 'EUR' | 'USD' | 'GBP';

/** Thrown when two amounts in different currencies are combined. */
export class CurrencyMismatchError extends Error {
  constructor(expected: Currency, actual: Currency) {
    super(`cannot combine ${expected} with ${actual}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class Money {
  private constructor(
    /** The amount in minor units: 1250 is 12.50. */
    readonly cents: number,
    readonly currency: Currency,
  ) {}

  /** An amount in major units, such as `12.5` for 12.50, rounded to the nearest cent. */
  static of(amount: number, currency: Currency): Money {
    return new Money(Math.round(amount * 100), currency);
  }

  static zero(currency: Currency): Money {
    return new Money(0, currency);
  }

  /** Throws `CurrencyMismatchError` when `other` is in another currency. */
  add(other: Money): Money {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
    return new Money(this.cents + other.cents, this.currency);
  }

  /** Multiplies by a factor (a quantity, or `1.2` for 20% tax), rounded to the nearest cent. */
  multiply(factor: number): Money {
    return new Money(Math.round(this.cents * factor), this.currency);
  }

  /**
   * Splits a non-negative amount by the given ratios without losing a cent: the shares always
   * add up to the original amount. `allocate([1, 1, 1])` splits it three ways.
   */
  allocate(ratios: readonly number[]): Money[] {
    const total = ratios.reduce((a, b) => a + b, 0);
    if (this.cents < 0 || ratios.some((ratio) => ratio < 0) || total <= 0) {
      throw new RangeError('allocate needs a non-negative amount and positive ratios');
    }
    const floors = ratios.map((ratio) => Math.floor((this.cents * ratio) / total));
    const remainder = this.cents - floors.reduce((a, b) => a + b, 0);
    return floors.map((cents, i) => new Money(cents + (i < remainder ? 1 : 0), this.currency));
  }

  /** The amount for display, such as `€12.50`; `locale` defaults to `en-US`. */
  format(locale = 'en-US'): string {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: this.currency }).format(
      this.cents / 100,
    );
  }
}

/** Adds amounts of one currency; an empty list is zero in that currency. */
export function sum(amounts: readonly Money[], currency: Currency): Money {
  return amounts.reduce((total, amount) => total.add(amount), Money.zero(currency));
}
