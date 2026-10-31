---
name: money
description: Use when TypeScript code adds, multiplies, splits or displays amounts of money. Covers the tiny-money library, which keeps amounts as whole cents so totals never drift.
---

# tiny-money

Never do arithmetic on money as floating-point numbers: `0.1 + 0.2` is not `0.3`, and dividing
100.00 by 3 loses a cent. Use `Money` from `tiny-money` instead. A `Money` holds whole `cents` and
a `currency` (`'EUR'`, `'USD'` or `'GBP'`, the `Currency` type), and every operation returns a new
`Money`.

| API | What it does |
|---|---|
| `Money.of(12.5, 'EUR')` | An amount in major units, rounded to the nearest cent |
| `Money.zero('EUR')` | Zero in a currency |
| `a.add(b)` | The sum; throws `CurrencyMismatchError` if the currencies differ |
| `a.multiply(3)` | Times a quantity or a rate (`1.2` adds 20% tax), rounded to the nearest cent |
| `a.allocate([1, 1, 1])` | Splits by ratios; the shares always add up to `a`, no cent lost |
| `a.format('de-DE')` | A display string such as `12,50 €`; the locale defaults to `en-US` |
| `sum(amounts, 'EUR')` | Adds a list of amounts; an empty list is zero |
| `a.cents`, `a.currency` | The raw amount in cents, and the currency |

## Totals

Turn every price into `Money` at the edge, compute with `multiply`, `add` and `sum`, and only call
`format` for display.

```ts
import { Money, sum } from 'tiny-money';

type Line = { unitPrice: number; quantity: number };

function orderTotal(lines: Line[]): string {
  const net = sum(
    lines.map((line) => Money.of(line.unitPrice, 'EUR').multiply(line.quantity)),
    'EUR',
  );
  const gross = net.multiply(1.2); // 20% VAT
  return gross.format('en-GB');
}
```

## Splitting

Split with `allocate`, never with `/`. Equal ratios split evenly; the leftover cents go to the
first shares.

```ts
import { Money } from 'tiny-money';

const [alice, bob, carol] = Money.of(100, 'EUR').allocate([1, 1, 1]);
// 33.34, 33.33 and 33.33: together exactly 100.00

const [platform, seller] = Money.of(59.99, 'USD').allocate([15, 85]); // a 15% commission
```

## Mixed currencies

`add` and `sum` throw `CurrencyMismatchError` rather than adding euros to dollars. Catch it, or
check `currency` first, when the input may mix currencies.

```ts
import { CurrencyMismatchError, Money, sum, type Currency } from 'tiny-money';

function walletTotal(payments: Money[], currency: Currency): Money | undefined {
  try {
    return sum(payments, currency);
  } catch (error) {
    if (error instanceof CurrencyMismatchError) return undefined;
    throw error;
  }
}
```
