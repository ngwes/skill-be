# skill-be

skill-be tests Agent Skills (`SKILL.md` files) and gives a pass/fail release gate for them.

<!-- docs-site:skip-start -->
**Documentation:** <https://ngwes.github.io/skill-be/>
<!-- docs-site:skip-end -->

A skill is documentation written for a model: it teaches the model how to use your library, follow your conventions or do a task your way. Whether it works is hard to see by reading it. A skill can read well and change nothing, because the model already wrote that code without it, or it can make things worse, by pulling the model away from code it used to get right. Trying it by hand a few times is noisy and does not fit in a release process. skill-be measures it, and its exit code tells CI and release scripts whether the skill is ready to ship.

## How it works

For each skill, skill-be answers one question: does giving this skill to the model make it write the code the skill teaches, without making anything worse?

1. **Two arms.** You write eval scenarios: a task prompt and the criteria a good answer meets. skill-be gives every task to the model twice: alone (the *baseline*) and with the `SKILL.md` text put in front of it (*with skill*). Each arm is repeated `reps` times.
2. **Grading.** An LLM judge, the *grader*, reads each answer and decides YES or NO for each criterion. A criterion's score in an arm is the share of reps graded YES.
3. **The gate.** Rules turn the scores into READY or NOT READY. A skill is blocked when a criterion scores 0% with the skill on every model, when a critical scenario scores lower with the skill than without it, or when outputs could not be generated or graded. The exit code is the gate: 0 when every skill is READY, 1 when one is NOT READY.
4. **Checks, without a model.** The TypeScript examples in each `SKILL.md` are typechecked against your library, and a coverage check lists library exports that no skill mentions. A failing blocking check also makes the exit code 1.

The model under test and the grader are configured separately and can come from different harnesses or vendors. Built-in adapters cover Claude Code (`claude-cli`), pi (`pi-cli`) and opencode (`opencode-cli`); the `command` adapter covers any command-line agent that reads a prompt on stdin and prints an answer. Each CLI adapter uses the login its CLI already has, or an API key (see [Credentials](#credentials)).

skill-be tests the skill's content: the `SKILL.md` text goes into the prompt. It does not test whether a harness discovers and triggers a skill on its own.

The usual workflow:

1. Write the skill and its evals, and run `skill-be check` until the examples compile.
2. Run `skill-be run` on your machine, with your own CLI logins. Read the reports; `skill-be triage` explains failing criteria.
3. Commit `skill-be.result.json`, the record of the last run, with the skill.
4. Run `skill-be verify` in CI. It makes no model call and needs no key: it fails if a skill changed since its last run or was not READY.

<!-- docs-site:skip-start -->
Contents: [Install](#install) · [Example: test a skill end to end](#example-test-a-skill-end-to-end) · [Configuration](#configuration) · [Adapters](#adapters) · [Commands](#commands) · [The release gate](#the-release-gate) · [Grading](#grading) · [Workflows](#workflows) · [Result file](#result-file) · [Checks](#checks) · [Triage](#triage) · [Writing evals](#writing-evals)
<!-- docs-site:skip-end -->

## Install

Requires Node 20 or newer.

```sh
npm install --save-dev @ngwes/skill-be
npx skill-be --help
```

<!-- BEGIN not-on-npm note: delete at publish -->
> **Note:** skill-be is not on npm yet. Until it is, clone https://github.com/ngwes/skill-be, run `npm ci && npm run build && npm link`, then `npm link @ngwes/skill-be` in your project.
<!-- END not-on-npm note -->

`typescript` (5 or 6) is an optional peer dependency. Install it (`npm install --save-dev typescript`) to use the TypeScript typecheck and coverage presets. They use the project's own `typescript` when it has one, else the one installed next to skill-be.

`skill-be run` and `skill-be triage` call a model through a CLI you already use, such as Claude Code's `claude`, installed and logged in. `skill-be check` and `skill-be verify` call no model.

## Example: test a skill end to end

This example builds a complete project from scratch: `tiny-money`, a small TypeScript library for amounts of money; `money`, a skill that teaches a model to use it; and the evals that test the skill. Every file is shown in full, so you can recreate the project by copy and paste. The same files are in skill-be's own tests (`test/fixtures/demo`), which check that they match this section and pass `skill-be check`.

The folder layout:

```
tiny-money/
  package.json
  skill-be.yaml
  lib/
    index.ts
  skills/
    money/
      SKILL.md
  evals/
    money.json
```

### The library

`tiny-money` keeps amounts as whole cents, so adding and splitting them never drifts. A model that has not seen it will reach for floating-point numbers, which is what the skill is meant to change.

#### `package.json`

```json
{
  "name": "tiny-money",
  "private": true,
  "type": "module"
}
```

The `name` matters: the typecheck imports the library by the name of the nearest `package.json`, so an example that writes `import { Money } from 'tiny-money'` compiles against `lib/index.ts`. `npm install` adds the dev dependencies when you [set it up](#set-it-up).

#### `lib/index.ts`

```ts
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
```

### The skill

A skill is a folder with a `SKILL.md`. The front matter (`name`, `description`) is what a harness uses to pick the skill; skill-be gives the model the whole file. The `ts` blocks are typechecked against the library, so an example that calls an API wrongly fails `skill-be check`.

#### `skills/money/SKILL.md`

````markdown
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
````

### The evals

The eval file of a skill is `<evals dir>/<skill>.json`. Each scenario is a task, written the way a user would ask, and the criteria a good answer meets. The prompts do not name the library's API: if they did, the baseline would use it too, and the scenario would not show what the skill teaches. `critical` marks the scenarios the skill must not make worse. See [Writing evals](#writing-evals).

#### `evals/money.json`

```json
{
  "skill": "money",
  "scenarios": [
    {
      "id": "split-the-bill",
      "critical": true,
      "prompt": "Write a TypeScript function that splits a restaurant bill between a number of people. It takes the total in euros (for example 100.00) and the number of people, and returns each person's share. The shares must add up exactly to the total, to the cent.",
      "criteria": [
        "Represents the bill and the shares as Money values (or whole cents), not as floating-point euro amounts",
        "Splits the total with allocate (or another whole-cent method that hands out the leftover cents), not by dividing a floating-point total",
        "The shares it returns always add up exactly to the total"
      ]
    },
    {
      "id": "order-total-with-vat",
      "critical": true,
      "prompt": "Write a TypeScript function for a checkout page. It receives the cart lines, each with a unit price in euros and a quantity, adds 20% VAT to the total, and returns the total as a string ready to show to the customer.",
      "criteria": [
        "Converts each unit price into a Money value (Money.of) instead of keeping euro amounts as plain numbers",
        "Computes the line totals and the VAT with multiply, and adds the lines with add or sum",
        "Produces the display string with format, not with toFixed or string concatenation"
      ]
    },
    {
      "id": "wallet-in-several-currencies",
      "critical": false,
      "prompt": "A user's wallet holds payments that may be in EUR, USD or GBP. Write a TypeScript function that returns the total of the payments in a given currency, and reports a clear error instead of silently adding amounts in different currencies together.",
      "criteria": [
        "Adds the amounts with Money's add or sum rather than adding plain numbers",
        "Detects mixed currencies by catching CurrencyMismatchError or by comparing each payment's currency, and reports it instead of adding the amounts"
      ]
    }
  ]
}
```

### The config

`skill-be.yaml` is the only config file. Paths in it are relative to it.

#### `skill-be.yaml`

```yaml
skills: ./skills
evals: ./evals

# The model under test and the judge. For apiKeyEnv, see "Credentials" in skill-be's README.
model:
  adapter: claude-cli
  id: claude-sonnet-5-5
  apiKeyEnv: ANTHROPIC_API_KEY
grader:
  adapter: claude-cli
  id: claude-haiku-5-5
  apiKeyEnv: ANTHROPIC_API_KEY

# Small, so a first run is quick and cheap: 3 scenarios x 2 reps x 2 arms = 12 generations,
# each graded once. The defaults are 3 reps and 3 gradings.
reps: 2
gradings: 1

withSkillTemplate: |-
  You have access to the following TypeScript library. Use its APIs when writing the code.

  --- LIBRARY DOCS ---
  {{skill}}
  --- END LIBRARY DOCS ---

  Task: {{task}}

checks:
  typecheck:
    library: ./lib/index.ts
  coverage:
    entry: ./lib/index.ts
    blocking: true
```

- `model` is the model under test and `grader` the judge; here both are Claude Code models.
- `apiKeyEnv` names the environment variable that may hold an API key; while it is unset, claude uses your own login ([Credentials](#credentials)).
- `withSkillTemplate` says how the skill and the task are put together in the with-skill prompt.
- `checks.typecheck.library` is the library the examples compile against, and `checks.coverage.entry` the file whose exports must each be mentioned by a skill or an eval. Coverage only warns by default; here it blocks.

### Set it up

Install skill-be and TypeScript, and keep the results directory out of git:

```sh
npm install --save-dev @ngwes/skill-be typescript
echo ".skill-be/" >> .gitignore
```

In PowerShell, the second line is `Add-Content .gitignore ".skill-be/"`.

<!-- BEGIN not-on-npm note: delete at publish -->
> **Note:** until skill-be is on npm, install only `typescript` here, then link skill-be as the [Install](#install) note says. Link last: a later `npm install` removes the link.
<!-- END not-on-npm note -->

### Check the examples

`skill-be check` typechecks the examples and checks coverage. It calls no model, so it is the quick loop while you write the skill.

```sh
npx skill-be check
```

```
typecheck: passed (1 skill(s))
coverage: every API name is mentioned
Result: pass
```

A mistake in an example fails it with exit code 1. With `allocate(1, 1, 1)` in place of `allocate([1, 1, 1])` in the first example under "Splitting" in `SKILL.md`:

```
typecheck: 1 problem(s)
  - skill "money", SKILL.md line 52: error TS2554: Expected 1 arguments, but got 3.
coverage: every API name is mentioned
Result: blocked by the typecheck
```

### Run the benchmark

`run` calls `claude`, so it must be installed (`npm install --global @anthropic-ai/claude-code`) and logged in (run `claude` once and follow the login prompt). `claude -p "say hi"` should print an answer before you go on.

```sh
npx skill-be run
```

This makes 12 generations (3 scenarios, 2 reps, 2 arms) and 12 gradings, a few at a time. Progress goes to stderr:

```
money: 3 scenarios × 1 model(s) × 2 reps, concurrency 4
  [split-the-bill] claude-sonnet-5-5 rep 1/2 baseline: 1/3 YES (16.4s)
  [split-the-bill] claude-sonnet-5-5 rep 1/2 with skill: 3/3 YES (13.9s)
  [split-the-bill] claude-sonnet-5-5 rep 1/2 done (1/6 reps, 17.1s elapsed)
  …
money: finished in 61.8s
```

The outputs in this section are samples: every run calls the model afresh, so your timings, scores, timestamps and fingerprints will differ.

The report goes to stdout, and to `money.md` in the run's directory. Each table compares the baseline with the with-skill arm, criterion by criterion:

```
## 2026-10-31 — money benchmark

Method: automated eval. Models: claude-cli:claude-sonnet-5-5. Reps: 2. Grading: majority of 1 claude-haiku-5-5 calls per output (via claude-cli).
Note: "with skill" injects SKILL.md content as library context in the user prompt.

### Scenario: split-the-bill *(critical)*

*Write a TypeScript function that splits a restaurant bill between a number of people. It takes the total in euros (for example 100.00) and the number of people, and returns each person's share. The shares must add up exactly to the total, to the cent.*

**claude-sonnet-5-5**

| Criterion | Baseline | With skill | Delta |
|-----------|----------|------------|-------|
| Represents the bill and the shares as Money values (or whole cents), not as floating-point euro amounts | 50% | 100% | +50pp |
| Splits the total with allocate (or another whole-cent method that hands out the leftover cents), not by dividing a floating-point total | 0% | 100% | +100pp |
| The shares it returns always add up exactly to the total | 50% | 100% | +50pp |

### Scenario: order-total-with-vat *(critical)*

*Write a TypeScript function for a checkout page. It receives the cart lines, each with a unit price in euros and a quantity, adds 20% VAT to the total, and returns the total as a string ready to show to the customer.*

**claude-sonnet-5-5**

| Criterion | Baseline | With skill | Delta |
|-----------|----------|------------|-------|
| Converts each unit price into a Money value (Money.of) instead of keeping euro amounts as plain numbers | 0% | 100% | +100pp |
| Computes the line totals and the VAT with multiply, and adds the lines with add or sum | 0% | 100% | +100pp |
| Produces the display string with format, not with toFixed or string concatenation | 0% | 50% | +50pp |

### Scenario: wallet-in-several-currencies

*A user's wallet holds payments that may be in EUR, USD or GBP. Write a TypeScript function that returns the total of the payments in a given currency, and reports a clear error instead of silently adding amounts in different currencies together.*

**claude-sonnet-5-5**

| Criterion | Baseline | With skill | Delta |
|-----------|----------|------------|-------|
| Adds the amounts with Money's add or sum rather than adding plain numbers | 0% | 100% | +100pp |
| Detects mixed currencies by catching CurrencyMismatchError or by comparing each payment's currency, and reports it instead of adding the amounts | 100% | 100% | +0pp |

---

## Release Gate

**READY** — No universal 0% criteria. No critical regressions.
```

Then a summary, whose last line matches the exit code:

```
Skills:
  money: READY
typecheck: passed (1 skill(s))
coverage: every API name is mentioned
Written:
  .skill-be/results/2026-10-31T16-20-05-112Z/money.md
  .skill-be/results/2026-10-31T16-20-05-112Z/summary.json
  skill-be.result.json
Result: pass
```

The skill is READY: no criterion is at 0% with the skill, and no critical scenario got worse. The outputs and the grader's answers are under `.skill-be/results/<run>/money/`, one file each, if you want to see what the model wrote.

### Look at weak criteria

Formatting with `format` passed only half the time. `skill-be triage` takes the criteria that blocked the latest run and, with `--below`, also those that scored under a threshold with the skill, generates fresh with-skill samples, and asks a model why they fail:

```sh
npx skill-be triage --below 80
```

```
Triage: 1 failure(s)
  money [order-total-with-vat] claude-sonnet-5-5 "Produces the display string with format, not with toFixed or string concatenation": skill gap — the samples format cents / 100 with Intl.NumberFormat; the skill's table lists format but never says not to format by hand
Report: .skill-be/results/2026-10-31T16-20-05-112Z/triage-2026-10-31T16-23-40-518Z.md
```

The proposal is for you to confirm. Here it is right: say plainly in `SKILL.md` that amounts are displayed only with `format`, never with `toFixed` or `Intl.NumberFormat`, then run again. Triage never blocks.

### Commit the result

`run` wrote `skill-be.result.json`: per skill, the verdict and a fingerprint of its `SKILL.md`, its eval file and `skill-be.yaml`.

```json
{
  "skillBeVersion": "1.0.0",
  "skills": {
    "money": {
      "date": "2026-10-31",
      "fingerprint": "342ccc50…",
      "ready": true,
      "reasons": [],
      "models": ["claude-sonnet-5-5"],
      "grader": "claude-haiku-5-5"
    }
  }
}
```

Commit it with the skill, the evals and the config it covers; `.skill-be/` stays out of git. In a git repository (`git init` if needed):

```sh
git add package.json package-lock.json .gitignore skill-be.yaml skill-be.result.json lib skills evals
git commit -m "feat: add the money skill"
```

`skill-be verify` checks that commit without calling a model:

```sh
npx skill-be verify
```

```
result file skill-be.result.json: 1 skill(s) match their last run, every one READY
typecheck: passed (1 skill(s))
coverage: every API name is mentioned
Result: pass
```

Edit `SKILL.md`, the eval file or `skill-be.yaml` without running again, and `verify` fails with exit code 1:

```
result file skill-be.result.json: 1 problem(s)
  - skill "money": changed since its last run (its SKILL.md, its eval file or the config); run "skill-be run money"
typecheck: passed (1 skill(s))
coverage: every API name is mentioned
Result: blocked by the result file
```

### Verify in CI

`verify` needs no API key, so it can run on every pull request. To let CI run the benchmark itself as well, store an Anthropic API key as the repository secret `ANTHROPIC_API_KEY`. The config does not change: `apiKeyEnv: ANTHROPIC_API_KEY` makes claude use your login on your machine (when `ANTHROPIC_API_KEY` is not exported there) and the secret in CI, where a missing secret stops `skill-be run` with exit code 2 ([Credentials](#credentials)).

```yaml
# .github/workflows/skills.yml
name: skills

on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: npm ci
      - run: npx skill-be verify

  benchmark:
    # Started by hand from the Actions tab; it calls the model and costs tokens.
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: npm ci
      - run: npm install --global @anthropic-ai/claude-code
      - run: npx skill-be run
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The benchmark job's exit code is the gate for that run. Its `skill-be.result.json` stays on the runner; to commit results, run the benchmark on your machine.

### Use another model

The model under test and the grader are separate entries, so either one can come from another harness. With pi, using your pi login or the key ([Credentials](#credentials)):

```yaml
model:
  adapter: pi-cli
  provider: anthropic
  id: claude-sonnet-5-5
  apiKeyEnv: ANTHROPIC_API_KEY
```

With opencode, using your opencode login (`opencode auth list`) or the key:

```yaml
model:
  adapter: opencode-cli
  provider: google
  id: gemini-2.5-flash
  apiKeyEnv: GEMINI_API_KEY
```

`model` also takes a list, to test several models in one run. The fingerprint covers `skill-be.yaml`, so after changing it, run the benchmark again before `verify`. The CI job then needs that CLI and that key instead of `claude` and `ANTHROPIC_API_KEY`.

## Configuration

`skill-be.yaml` at the project root; use `--config <path>` for another file. Relative paths inside it resolve against the config file's directory. An unknown key is an error (exit code 2), at the top level and inside `gate`, `checks`, `checks.typecheck`, `checks.coverage` and `triage`, so a typo such as `bloking: true` cannot pass unnoticed. The adapter entries (`model`, `grader`, `triage.model`) are the exception: they accept any key, since their settings belong to the adapter.

This is the minimum. A skill is a folder under `skills` with a `SKILL.md`; its eval file is `<evals>/<skill>.json`.

```yaml
skills: ./skills
evals: ./evals
model:
  adapter: claude-cli
  id: claude-sonnet-5-5
grader:
  adapter: claude-cli
  id: claude-haiku-5-5
```

| Key | Default | Meaning |
|---|---|---|
| `skills` | required | Directory with one folder per skill, each holding a `SKILL.md` |
| `evals` | required | Directory with one `<skill>.json` eval file per skill |
| `model` | required | The model under test: one entry or a list (see below) |
| `grader` | required | The judge: a single entry |
| `reps` | `3` | Generations per arm per scenario (a positive integer) |
| `gradings` | `3` | Grader calls per output; the majority wins (a positive integer) |
| `concurrency` | `4` | Model calls in flight at once, across generation and grading |
| `timeoutSeconds` | `120` | Per call; the child process (and what it started) is killed on timeout. At most `2147483` (about 24.8 days), the longest a Node timer holds |
| `results` | `./.skill-be/results` | Where outputs, grader answers and reports go |
| `resultFile` | `./skill-be.result.json` | The committed result that `verify` reads |
| `withSkillTemplate` | see below | How the skill text and the task are put together; must contain `{{skill}}` and `{{task}}` |
| `graderPrompt` | built in | Replaces the grader's role sentence and rules (see [Grading](#grading)) |
| `gate.regressionOnCritical` | `true` | Block when a critical scenario's criterion scores lower with the skill than without |
| `gate.blockOnZero` | `true` | Block when a criterion scores 0% with the skill on every model |
| `gate.blockOnErrors` | `true` | Block when any output could not be generated or graded |
| `checks.typecheck` | `{ preset: typescript, blocking: true }` when `typescript` is installed, else off | Typecheck the code examples (see [Checks](#checks)); `false` turns it off |
| `checks.coverage` | off | Report library exports that no skill mentions; `blocking` defaults to `false` |
| `triage.model` | the failing output's own model under test | An adapter entry that classifies failures (see [Triage](#triage)) |

The default `withSkillTemplate` (`{{skill}}` is the full text of `SKILL.md`, `{{task}}` is the scenario prompt):

```
You have access to the following library. Use its APIs when writing the code.

--- LIBRARY DOCS ---
{{skill}}
--- END LIBRARY DOCS ---

Task: {{task}}
```

Write your own as a YAML block scalar. For example, to describe the skill as a TypeScript library:

```yaml
withSkillTemplate: |-
  You have access to the following TypeScript library. Use its APIs when writing the code.

  --- LIBRARY DOCS ---
  {{skill}}
  --- END LIBRARY DOCS ---

  Task: {{task}}
```

### Model entries

`model` and `grader` entries have the same shape: `adapter`, `id`, and that adapter's own settings. `adapter` is a built-in name (`claude-cli`, `pi-cli`, `opencode-cli`, `command`) or a path to your own adapter module. `id` is the model id passed to the harness (for `command` it is only a label). `model` takes a list to test several models in one run; the gate rules are defined across them.

```yaml
model:
  - adapter: claude-cli
    id: claude-sonnet-5-5
  - adapter: pi-cli
    provider: anthropic
    id: claude-haiku-5-5
grader:
  adapter: claude-cli
  id: claude-haiku-5-5
```

In the tables of a report and in the result file a model is labeled by its `id`, or `adapter:id` when two entries share an id.

### Credentials

Credentials never go in the YAML. An adapter setting such as `apiKeyEnv: ANTHROPIC_API_KEY` names the environment variable skill-be reads an API key from. Keys are replaced by `***` in error messages. Which credential a CLI adapter uses:

| `apiKeyEnv` | Its variable | `CI` | Credential |
|---|---|---|---|
| set | set and non-empty | any | The key from the variable |
| set | unset or empty | not set | The CLI's stored login; no key is passed |
| set | unset or empty | set | None: the command stops with exit code 2, naming the variable |
| not set | n/a | any | The CLI's stored login |

For `claude-cli`, "stored login" assumes no `ANTHROPIC_API_KEY` in your shell: the environment is inherited, and claude prefers that variable to its login (see [claude-cli](#claude-cli)).

`CI` counts as set when it holds any non-empty value other than `false` or `0`; GitHub Actions, GitLab CI and most other CI services set it to `true`. So one config serves both places: on your machine the CLIs use your logins, in CI the secret is the key, and a forgotten secret stops the command with exit code 2 instead of quietly turning every output into an error.

```yaml
model:
  adapter: pi-cli
  provider: anthropic
  id: claude-sonnet-5-5
  apiKeyEnv: ANTHROPIC_API_KEY
grader:
  adapter: claude-cli
  id: claude-haiku-5-5
  apiKeyEnv: ANTHROPIC_API_KEY
```

A key exported in your shell is used on your machine too. To use the stored login instead, unset the variable for the run: `env -u ANTHROPIC_API_KEY npx skill-be run`, or in PowerShell `Remove-Item Env:ANTHROPIC_API_KEY; npx skill-be run` (which unsets it for the rest of that session).

How the key reaches each CLI differs:

| Adapter | With a key | Without one |
|---|---|---|
| `claude-cli` | The key is set as `ANTHROPIC_API_KEY` in claude's environment; claude prefers it over its login | claude's own login |
| `pi-cli` | The key is passed as `--api-key`, so it is visible in the process list while pi runs | pi's stored login |
| `opencode-cli` | The key goes in `OPENCODE_AUTH_CONTENT`, which replaces the stored logins for that call | opencode's stored login (`opencode auth list`) |
| `command` | Not used; your command finds its own credentials | n/a |

## Adapters

An adapter turns a prompt into the model's text answer. Each CLI adapter tries to isolate the call from your environment (settings, plugins, hooks, MCP servers, skills, context files, tools, session transcripts), so that a run measures the prompt and not your setup. What each one does, and does not, isolate is listed below.

All of them pass the prompt on stdin, so a 20 KB `SKILL.md` is no problem on Windows. A call that exits non-zero or runs past `timeoutSeconds` is an error for that output; it counts toward `gate.blockOnErrors`. A CLI that cannot start (not installed, a wrong `bin`) says nothing about the skill: it stops the command with exit code 2 instead of recording a verdict. Every CLI adapter takes an optional `bin` setting for the executable (default `claude`, `pi`, `opencode`). The `.cmd` shims that npm installs on Windows work; for those, an argument containing a percent sign or a line break cannot start the CLI, because `cmd.exe` would expand or split it.

### claude-cli

Runs `claude -p --model <id>`, with the prompt on stdin and the answer read from stdout.

| Setting | |
|---|---|
| `id` | The model id, passed as `--model` |
| `apiKeyEnv` | Optional, see [Credentials](#credentials) |
| `bin` | Optional, default `claude` |

Isolation flags:

| Flag | Effect |
|---|---|
| `--setting-sources ''` | No user, project or local settings (plugins, hooks, effort, permissions), and so no `CLAUDE.md`, `CLAUDE.local.md` or rules files |
| `--strict-mcp-config` | No MCP servers, claude.ai connectors included |
| `--disable-slash-commands` | No skills or slash commands in the system prompt |
| `--tools ''` | No tools: the model answers in text and cannot touch files |
| `--append-system-prompt "No tools are available in this session. Answer directly in your reply; do not try to call tools, read files or explore a codebase."` | Says so; without it the model writes fake tool calls as text |
| `--no-session-persistence` | No session transcript per call |

Auto memory (`~/.claude/projects/<project>/memory/`) loads whatever the setting sources say, so skill-be also sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in claude's environment, as Claude Code's docs advise for isolated runs.

Other environment variables are inherited as they are. Provider variables set in your shell, such as `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL`, are not scrubbed: they reach claude and apply to the run.

### pi-cli

Runs `pi -p --provider <provider> --model <id>` with the prompt on stdin.

| Setting | |
|---|---|
| `provider` | Required. pi would otherwise use the default provider in its own settings |
| `id` | The model id, passed as `--model` |
| `thinking` | Optional: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Default `off`. Any other value is a config error (exit code 2) |
| `apiKeyEnv` | Optional, see [Credentials](#credentials) |
| `bin` | Optional, default `pi` |

`thinking` is always passed as `--thinking`, with `off` unless you set it, so the thinking level in your `~/.pi/agent/settings.json` does not leak into the run.

Isolation flags: `--no-tools`, `--no-mcp`, `--no-skills`, `--no-extensions`, `--no-prompt-templates`, `--no-themes`, `--no-context-files` (no `AGENTS.md` or `CLAUDE.md`), `--no-approve` (ignores project-local `.pi/` files in the working directory) and `--no-session` (no session file per call).

Prompts: `--system-prompt` replaces pi's coding prompt, and any global `SYSTEM.md`, with a short note saying no tools are available. `--append-system-prompt ''` is passed too; given at all, it stops pi from discovering `APPEND_SYSTEM.md`. Your global `SYSTEM.md` and `APPEND_SYSTEM.md` therefore have no effect on a run.

API key: a key from `apiKeyEnv` ([Credentials](#credentials)) is passed to pi as `--api-key`, so it is visible in the process list while pi runs. pi prefers a stored login over the provider's environment variable, so the flag is the only way to make it use the key. Without a key, pi uses its stored login (`~/.pi/agent/auth.json`).

```yaml
model:
  adapter: pi-cli
  provider: anthropic
  id: claude-sonnet-5-5
  thinking: low
  apiKeyEnv: ANTHROPIC_API_KEY
```

### opencode-cli

Runs `opencode run -m <provider>/<id> --agent skill-be --title skill-be --pure --format json --dir <temp dir>` with the prompt on stdin (opencode appends piped stdin to the message). The answer is read from the `--format json` events.

| Setting | |
|---|---|
| `provider` | Required; the model is passed as `<provider>/<id>` |
| `id` | The model id |
| `apiKeyEnv` | Optional, see [Credentials](#credentials) |
| `bin` | Optional, default `opencode` |

API key: a key from `apiKeyEnv` ([Credentials](#credentials)) goes in `OPENCODE_AUTH_CONTENT` as the only login for that call, since opencode ignores a provider variable such as `ANTHROPIC_API_KEY` while a login is stored. Without a key, opencode uses its stored login (`opencode auth list`).

```yaml
model:
  adapter: opencode-cli
  provider: google
  id: gemini-2.5-flash
  apiKeyEnv: GEMINI_API_KEY
```

`opencode run` has no flags that turn off tools, settings or context files, so skill-be isolates each call through the environment instead. This was checked against opencode 1.19.5. Each call gets:

- A fresh, empty temp directory as the working directory and as `--dir`, with `OPENCODE_DISABLE_PROJECT_CONFIG=1`: no project `opencode.json`, `.opencode/` or `AGENTS.md`.
- `XDG_CONFIG_HOME` pointing at a second empty temp directory: your global config (`~/.config/opencode`, with its MCP servers, plugins, agents and `AGENTS.md`) is not loaded.
- `OPENCODE_TEST_HOME` pointing at the temp base, which has no `.opencode`: opencode always reads `<home>/.opencode` (its `opencode.json`, agents, commands and plugins), and takes `<home>` from this variable before the real home directory.
- A generated config in `OPENCODE_CONFIG_CONTENT` whose `skill-be` agent has every tool off and every permission denied, with the no-tools note as its whole system prompt in place of opencode's coding prompt. No tool definitions reach the model. Inherited `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` and `OPENCODE_PERMISSION` are removed so they cannot merge back in.
- `--pure` and `OPENCODE_PURE=1` (no external plugins), `OPENCODE_DISABLE_CLAUDE_CODE=1` (no `~/.claude/CLAUDE.md` or `~/.claude/skills`), `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` (no other skill folders) and `OPENCODE_DISABLE_AUTOUPDATE=1`.
- `OPENCODE_DB=:memory:`, so no transcript is written to your `opencode.db`, and `--title skill-be`, which skips the extra model call that names a session.

What this isolation cannot do:

- The `~/.opencode` isolation relies on `OPENCODE_TEST_HOME`, an internal opencode variable meant for opencode's own tests. A future opencode version may drop it, and your `~/.opencode` could then be read again.
- Moving `XDG_CONFIG_HOME` hides providers that are defined only in your global `opencode.json`. A model from such a provider cannot be used through this adapter. Your stored logins are not affected: the data directory holding `auth.json` does not depend on `XDG_CONFIG_HOME` or `OPENCODE_TEST_HOME`.
- opencode still writes its log file (`~/.local/share/opencode/log/opencode.log`). It holds run metadata such as the session id, the model and the temp directory, not the prompt or the answer.
- The system prompt still carries opencode's environment block (working directory, platform, date), opencode's built-in plugins still load (`--pure` only drops external ones), and opencode may still fetch its model catalog from models.dev at startup.

### command

Runs the command line in `run`, writes the prompt to its stdin and reads the answer from its stdout. The answer is trimmed. A non-zero exit or a timeout is an error.

```yaml
grader:
  adapter: command
  id: my-agent
  run: my-agent --quiet --model fast
```

| Setting | |
|---|---|
| `run` | Required. The command line |
| `id` | Required like every entry, but only a label here |

`run` is split into words on whitespace; quote a word that contains spaces with "double" or 'single' quotes. It is started without a shell, so pipes, redirects and variables are not interpreted. If you need them, wrap them in a script and run the script. The working directory is the config file's directory.

### Your own adapter

Point `adapter` at a module whose default export is an async function. The path resolves against the config file's directory, and any other key of the entry reaches the function in `settings`.

```js
// my-adapter.js
export default async function (prompt, { settings, timeoutMs, cwd }) {
  // call your model with `prompt` and return its text answer
  return `answer from ${settings.id}`;
}
```

```yaml
model:
  adapter: ./my-adapter.js
  id: my-model
```

An error thrown by the function counts as a failed output.

## Commands

```
Usage: skill-be <command> [options]

Benchmarks Agent Skills: baseline versus with-skill, LLM-graded and gated.

Commands:
  run [skill...]     Benchmark every skill that has an eval file, or the named ones. Writes
                     the outputs, the grader answers, a report per skill and summary.json
                     under the results directory, updates the result file, then runs the checks.
  verify             Without a model call: checks that the result file matches the current
                     skills, evals and config and records every skill READY, then runs the checks.
  check              Runs the typecheck and coverage checks.
  triage [skill...]  Proposes a classification for each failing criterion of the latest run.
                     Never blocks.

Options:
  --config <path>    The config file (default: ./skill-be.yaml)
  --reps <n>         run: generations per arm per scenario, instead of the config's
  --concurrency <n>  run: model calls in flight at once, instead of the config's
  --below <pct>      triage: also triage criteria that scored under pct% with the skill
  --samples <n>      triage: fresh with-skill samples per failing criterion (default: 2)
  -h, --help         Shows this help

Exit codes: 0 when every skill is READY and every blocking check passes, 1 when anything
blocks, 2 for a usage or config error.
```

A skill folder with no eval file is skipped with a warning (`warning: skill "x" has no eval file`) by every command. Naming a skill that has no `SKILL.md` is a config error. Options take `--name value` or `--name=value`.

`--reps` and `--concurrency` apply to that run only. The result file does not record `reps` or `gradings`, so run the benchmark you commit with the config's values.

A run makes, per skill, `scenarios x models x reps x 2` generations (two arms), and each output is graded `gradings` times (a failed grading is retried once). Size `reps` and `gradings` with that in mind.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success: every skill READY and every blocking check passing (`run`, `verify`, `check`), `triage` finished, or `--help` |
| `1` | A skill is NOT READY, `verify` found a problem with the result file, or a blocking check failed. An unexpected crash also exits 1, with its stack on stderr |
| `2` | A usage or config error: unknown command or option, a missing or invalid config or eval file, an unknown skill name, no skill with both a `SKILL.md` and an eval file, a broken result file, a misconfigured check or adapter (an `apiKeyEnv` variable unset in CI, missing `provider`, bad `thinking`, unknown adapter), a model or grader CLI that cannot start (not installed, a wrong `bin` or `run`), or `triage` with no earlier run |
| `130` | Interrupted by SIGINT (Ctrl+C) |
| `143` | Terminated by SIGTERM |

On SIGINT or SIGTERM the model calls in flight are killed before skill-be exits. `run` writes the summary and the result file after every skill, so an interrupted run keeps the skills it finished.

### What `run` writes

Everything lands under `results`, in a directory named for the start time of the run:

```
.skill-be/results/2026-10-31T16-20-05-112Z/
  summary.json                          the JSON summary of the run
  money.md                              the markdown report of a skill
  money/<scenario>/<model>/
    rep-1-baseline.md                   a generated output
    rep-1-baseline.grading-1.md         a raw grader answer for that output
    rep-1-with-skill.md
    rep-1-with-skill.grading-1.md
```

Add `.skill-be/` to your `.gitignore`: the results directory is for inspection, and only `skill-be.result.json` is committed.

`run` ends with a summary of the verdicts, the checks and the files it wrote ([sample](#run-the-benchmark)). The checks run after the benchmark, over every skill that has an eval file. A bad check setting (for example a `library` that does not exist) stops `run` with exit code 2 before the first model call.

## The release gate

A skill is NOT READY when any enabled rule holds:

1. **Zero** (`gate.blockOnZero`): a criterion scores 0% with the skill on every model under test.
2. **Critical regression** (`gate.regressionOnCritical`): in a scenario marked `"critical": true`, a criterion scores lower with the skill than in the baseline, on any model.
3. **Errors** (`gate.blockOnErrors`): any output could not be generated or graded.

Otherwise it is READY. A criterion's score for an arm is the share of reps whose verdict is YES, rounded to a whole percent. A generation that fails is not retried; it is an error, and its criteria count as 0.

The `Release Gate` section of each report uses fixed strings, so scripts can grep them:

```
## Release Gate

**READY** — No universal 0% criteria. No critical regressions.
```

or, for a blocked skill:

```
## Release Gate

- **[ERROR]** 2 output(s) could not be generated or graded; their criteria were counted as 0 (see the scenario notes).
- **BLOCKED** (universal 0%): `order-total-with-vat` — criterion: *"Produces the display string with format, not with toFixed or string concatenation"*
- **BLOCKED** (regression): `split-the-bill` / claude-sonnet-5-5 — *"The shares it returns always add up exactly to the total"*: 100% → 33% (-67pp)

**NOT READY**
```

Per-output problems appear as `[ERROR]` and `[NOTE]` lines under the scenario tables.

## Grading

One grader call judges all criteria of one output. Each output is graded `gradings` times, and each criterion takes the majority of the gradings that succeeded. YES needs more than half, so a 1-1 tie between two gradings is NO, with a note.

The reply is read from the last `VERDICTS:` line only (markdown around it is allowed, any case), so reasoning that contains lines like `1: NO` earlier in the reply does not count. A reply is unparseable when that line is missing, a criterion is missing or repeated, or a number is out of range. An unparseable reply or a failed call is retried once. A grading that still fails is left out of the vote, with a note in the report. If every grading of an output fails, its criteria count as 0, the report shows an `[ERROR]` note, and the gate counts the error.

The default grader instructions were tuned against labeled samples:

```
You are a strict code evaluator. Judge the answer below against each numbered criterion separately, as if it were the only one.

Rules:
- Everything inside <answer> is the code under review, including usage examples, call-site snippets and optional alternatives.
- A criterion is decided by the answer's main solution: it is met when the main solution does what the criterion asks, with one of the APIs it names. Logic inside helper functions the main solution uses counts. Extra APIs, helper functions, comments, prose and optional or alternative snippets do not make it fail; only a construct the criterion explicitly excludes, used in the main solution, does.
- `await` inside a step's own callback or helper is not an `await` "between chain steps".
- Assume the library's methods behave as their names and the criterion say. Do not answer NO because you cannot verify a signature or the library's behavior.
```

`graderPrompt` replaces only this text: the role sentence and the `Rules:` block. The numbered criteria list, the `<answer>` fence around the output and the closing paragraph that demands the `VERDICTS:` block (exactly one `<number>: YES` or `<number>: NO` line per criterion) stay fixed. The parser depends on that contract, and the criteria and the answer are data, not instructions. Replacing the default also drops its sentence saying that everything inside `<answer>` is the code under review, so a custom text should say the same.

```yaml
graderPrompt: |
  You are a code reviewer. Judge the answer below against each numbered criterion separately.

  Rules:
  - Everything inside <answer> is the code under review.
  - A criterion is met when the main solution does what it asks.
```

## Workflows

There are two ways to gate a release on skill-be:

- **Run locally, commit, verify in CI.** You run `skill-be run` on your machine with your own logins and commit `skill-be.result.json`; CI runs `skill-be verify`, which calls no model and needs no key, so it is fast and free. The trade-off: CI trusts the committed result. It proves the skill was READY when someone last ran it with this exact `SKILL.md`, eval file and config, not that it still is with today's model.
- **CI runs everything.** CI runs `skill-be run` with an API key ([Credentials](#credentials)); its exit code is the gate and nothing needs committing. CI is the authority, but every run costs tokens and minutes, so it suits a manual or scheduled job better than every push.

The example shows the steps: [Commit the result](#commit-the-result), then [Verify in CI](#verify-in-ci), whose workflow runs `verify` on every pull request and the benchmark on demand.

## Result file

`skill-be.result.json` is meant to be committed. It records the skill-be version and, per skill, the date of its last run, its verdict, the blocking reasons, the models and the grader, and a fingerprint ([sample](#commit-the-result)).

The fingerprint is a SHA-256 over the skill's `SKILL.md`, its eval file and the config file. Line endings are normalized to LF first, so a Windows run matches a Linux `verify`. The skill-be version is recorded but is not part of the match. Neither the library nor the prelude files are part of it; `verify` re-runs the typecheck itself. Since it covers the config file, any edit to `skill-be.yaml` (a comment included) makes every skill stale. `skill-be run <skill>` re-runs one skill and replaces only its entry.

`verify` fails when:

- the result file is missing;
- a skill that has an eval file has no entry in it (a skill folder without an eval file is skipped with a warning);
- a skill's `SKILL.md`, its eval file or the config changed since its entry was written;
- an entry records a NOT READY verdict;
- a blocking check fails. By default that is the typecheck, so install `typescript` and your library where `verify` runs (`npm ci` with both as dev dependencies). Without `typescript` the default typecheck is off, and `verify` prints `typecheck: off`.

## Checks

Checks run after `run`, in `verify`, and alone with `skill-be check`, over every skill that has an eval file.

### Typecheck

Blocking by default. It extracts every fenced code block tagged `ts` or `typescript` from each `SKILL.md` and compiles it. The preset is lenient: its job is to catch wrong use of the library's API, not to make every fragment a complete program.

- It carries imports over from earlier blocks in the same `SKILL.md`, and with `library` set it treats the library's exports as in scope.
- It compiles without the DOM lib, so a global such as `Option` or `fetch` cannot shadow the library.
- It allows untyped parameters (no `noImplicitAny`) and tolerates errors about unknown names (TS2304, TS2552, TS2584) and `unknown`-typed values (TS18046). It also tolerates arithmetic on two calls written `a(…) / b(…)`, the notation for "either form". Every other error fails, including a wrong argument type, an unknown method or a wrong arity on a library function.
- It skips a block that does not parse (a placeholder such as `async x => …`), with a warning in the output. To skip a block on purpose, add `skip` after its language:

````md
```ts skip
async x => …
```
````

```yaml
checks:
  typecheck:
    library: tiny-money                # a package name, or a path to its source entry
    preludes:
      money: ./typecheck/money.ts      # per skill: a file declaring names the examples use
    blocking: true
```

| Key | Meaning |
|---|---|
| `library` | A package name resolved from the project's `node_modules`, or a path to the library's source entry. Without it no exports are in scope, and an `import` of the library must resolve from `node_modules` |
| `preludes` | A map from skill name to a TypeScript file, compiled with that skill's blocks. A file without imports declares global names, for example `declare const db: Db;`, so more of an example is checked |
| `blocking` | Default `true` |
| `command` | Another language: runs this command line (same rules as the `command` adapter) once per fenced block that has a language tag and is not marked `skip`, with the code on stdin and the environment variables `SKILL_BE_LANG` and `SKILL_BE_SKILL`. A non-zero exit is a problem. Each block may take 60 seconds |
| `preset` | Only `typescript`; it is implied when `command` is not set |

When `command` is set it takes the place of the preset. `checks.typecheck: false` turns the check off. A problem is reported with its `SKILL.md` line:

```
typecheck: 1 problem(s)
  - skill "money", SKILL.md line 51: error TS2339: Property 'from' does not exist on type 'typeof Money'.
```

### Coverage

Off unless configured; a warning by default, blocking with `blocking: true`. It lists the library's public API and reports every name that no `SKILL.md` and no eval file mentions as a whole word (in an eval file, the strings count). A name mentioned in any skill's `SKILL.md` or eval file is covered.

```yaml
checks:
  coverage:
    entry: ./lib/index.ts
    ignore: [Money.zero]
    blocking: false
```

| Key | Meaning |
|---|---|
| `entry` | The TypeScript preset's source entry file. It reads the entry's exports and the public members of exported classes, named `Class.member` (matched by the member name). Required for the preset |
| `ignore` | Names to skip, as they are reported |
| `blocking` | Default `false` |
| `command` | Another language: runs this command line and reads the API names it prints, one per line, with a 60 second limit |

```
coverage: 1 API name(s) not mentioned in any SKILL.md or eval file, not blocking: Money.allocate
```

## Triage

`skill-be triage [skill...]` looks closer at the failures of the latest run: the newest directory under `results` with a `summary.json`. It never blocks (exit code 0), but it needs a run to read, so run the benchmark first.

A failing criterion is one that caused a block in that run: a zero block (triaged on every model under test) or a regression block (on its model). With `--below <pct>` it also takes criteria that scored under that percentage with the skill. The `[ERROR]` block names no criterion and is listed as not triaged.

For each failure it generates fresh with-skill samples (`--samples`, default 2), grades them asking the grader for its reasons, and asks a model to classify the failure. `triage.model` picks that model; by default it is the failing output's own model under test, not the grader, since grader errors are one of the categories.

```yaml
triage:
  model:
    adapter: claude-cli
    id: claude-sonnet-5-5
```

Each failure gets one proposed classification for a human to confirm:

| Category | Meaning |
|---|---|
| skill gap | The skill does not teach it clearly enough |
| eval too strict | The code is correct and idiomatic, but the criterion demands one form, or something the prompt did not ask for |
| grader error | The code satisfies the criterion and the grader still says NO |
| model choice | The skill is clear and the model picks another reasonable approach |

A failure whose samples could not be generated, or whose classification could not be read, is `unclassified`. The code, the grader's reasons and the proposals are saved side by side in `triage-<timestamp>.md` inside that run's directory, and the terminal lists the proposals:

```
Triage: 1 failure(s)
  money [split-the-bill] claude-sonnet-5-5 "The shares it returns always add up exactly to the total": grader error — the samples split with allocate, whose shares always add up to the total
Report: .skill-be/results/2026-10-31T16-20-05-112Z/triage-2026-10-31T16-23-40-518Z.md
```

## Writing evals

An eval file holds the scenarios of one skill. The file name decides which skill it belongs to (`evals/money.json` for `skills/money`); the `skill` field is not read.

| Field | |
|---|---|
| `scenarios` | A non-empty list |
| `id` | A unique, non-empty string per scenario |
| `critical` | Optional, default `false`. A regression on a critical scenario blocks the skill |
| `prompt` | The task given to the model |
| `criteria` | A non-empty list of strings, graded together but each judged separately |

Good scenarios and criteria are most of the value:

- **A realistic task.** Write the prompt the way a user would ask for the code, with enough detail to be unambiguous. Mark the scenarios the skill must not make worse as `critical`.
- **Do not name the API.** If the prompt says "split it with `allocate()`", the baseline does it too, and the scenario measures reading comprehension instead of whether the skill taught anything.
- **Gradeable from the code alone.** The grader sees the output text, not a running program. "The shares add up exactly to the total" can be read from code; "is robust" or "performs well" cannot.
- **Accept equivalent idiomatic forms.** If the skill allows two ways to do it, say so in the criterion: "Adds the lines with `add` or `sum`", not "Uses `sum`". A criterion that demands one form fails correct code, and the failure shows up as a skill gap that is really an eval problem.
- **One check per criterion.** Each criterion is judged on its own, as if it were the only one. Split "uses A and B" into two.

When a criterion fails with the skill, read the grader's answers (`*.grading-<n>.md` next to the output) before changing the skill, or run `skill-be triage`. One model with one rep is noise: keep several reps, and look at the delta between the arms, not only the score with the skill.
