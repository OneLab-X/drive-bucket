/**
 * Tiny concurrency limiter (p-limit semantics). Inlined so the CJS build has no ESM-only deps.
 */
export interface Limiter {
  <T>(fn: () => Promise<T>): Promise<T>;
  readonly activeCount: number;
  readonly pendingCount: number;
}

export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError('concurrency must be a positive integer');
  }
  const queue: Array<() => void> = [];
  let active = 0;

  const next = () => {
    if (active >= concurrency) return;
    const run = queue.shift();
    if (run) {
      active++;
      run();
    }
  };

  const limit = <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });

  Object.defineProperties(limit, {
    activeCount: { get: () => active },
    pendingCount: { get: () => queue.length },
  });
  return limit as Limiter;
}
