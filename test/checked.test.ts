import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { all, check, fail, firstProblem, pass } from '../src/checked.js';
import { loadConfig } from '../src/config.js';

describe('checked helpers', () => {
  it('pass and fail hold a value or one message', () => {
    expect(pass(3).unwrap()).toBe(3);
    expect(fail<number>('bad').unwrapInvalid()).toEqual(['bad']);
  });

  it('check builds the message only when the condition fails', () => {
    let built = 0;
    const message = (): string => {
      built++;
      return 'no';
    };

    expect(check(true, 'yes', message).unwrap()).toBe('yes');
    expect(built).toBe(0);
    expect(check(false, 'yes', message).unwrapInvalid()).toEqual(['no']);
    expect(built).toBe(1);
  });

  it('all builds the object when every field passes', () => {
    expect(all({ a: pass(1), b: pass('two'), c: pass(false) }).unwrap()).toEqual({
      a: 1,
      b: 'two',
      c: false,
    });
  });

  it('all collects the messages of every failing field, in key order', () => {
    const checked = all({ a: fail<number>('a'), b: pass(2), c: fail<string>('c') });

    expect(checked.unwrapInvalid()).toEqual(['a', 'c']);
  });

  it('firstProblem keeps the value or the first message', () => {
    expect(firstProblem(pass(1)).unwrapRight()).toBe(1);
    expect(firstProblem(all({ a: fail('first'), b: fail('second') })).unwrapLeft()).toBe('first');
  });
});

describe('loadConfig with several problems', () => {
  it('names the first problem in the order the config is read', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'skill-be-checked-'));
    try {
      const file = path.join(dir, 'skill-be.yaml');
      // The structure (keys and sections) is read before the values.
      await writeFile(file, 'reps: 0\nchecks:\n  typecheks: false\n');

      const error = await loadConfig(file, { typescriptInstalled: () => true }).then(
        () => undefined,
        (e: unknown) => e as Error,
      );

      expect(error?.message).toBe(
        `${file}: unknown key "checks.typecheks" (known keys: typecheck, coverage)`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
