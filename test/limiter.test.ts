import { describe, expect, it } from 'vitest';
import { createLimiter } from '../src/limiter.js';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createLimiter', () => {
  it('never runs more than n tasks at once and preserves each result', async () => {
    const limit = createLimiter(2);
    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;

    const results = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) =>
        limit(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await tick(20 + (i % 3) * 10);
          inFlight--;
          completed++;
          return `result ${i}`;
        }),
      ),
    );

    expect(results).toEqual([0, 1, 2, 3, 4, 5].map((i) => `result ${i}`));
    expect(maxInFlight).toBe(2);
    expect(completed).toBe(6);
  });

  it('frees the slot of a task that fails, and passes the failure to its caller', async () => {
    const limit = createLimiter(1);

    const failing = limit(async () => {
      throw new Error('task failed');
    });
    const throwingSync = limit(() => {
      throw new Error('threw before returning a promise');
    });
    const next = limit(async () => 'still runs');

    await expect(failing).rejects.toThrow('task failed');
    await expect(throwingSync).rejects.toThrow('threw before returning a promise');
    await expect(next).resolves.toBe('still runs');
  });

  it('rejects a limit that is not a positive integer', () => {
    expect(() => createLimiter(0)).toThrow(RangeError);
    expect(() => createLimiter(1.5)).toThrow(RangeError);
  });
});
