/**
 * @module util/concurrency
 *
 * Helpers for bounded parallelism and timing.
 */

import pLimit from 'p-limit';

/**
 * Runs `fn` over `items` with at most `concurrency` invocations in flight,
 * preserving result order.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = pLimit(Math.max(1, concurrency));
  return Promise.all(items.map((item, i) => limit(() => fn(item, i))));
}

/** Promise-based sleep. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rejects if `promise` does not settle within `ms`. The underlying work is
 * not cancelled (JS has no generic cancellation), so callers should also pass
 * an `AbortSignal` where the API supports one.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
