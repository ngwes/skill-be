/** Returns a function that runs tasks with at most `n` of them in flight at once, in call order. */
export function createLimiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`The concurrency limit must be a positive integer, got ${n}`);
  }
  let active = 0;
  const waiting: Array<() => void> = [];

  const startNext = (): void => {
    if (active >= n) return;
    const start = waiting.shift();
    if (!start) return;
    active++;
    start();
  };

  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        // `then(task)` also turns a task that throws synchronously into a rejection.
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active--;
            startNext();
          });
      });
      startNext();
    });
}
