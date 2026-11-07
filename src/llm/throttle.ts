/**
 * @module llm/throttle
 *
 * Client-side requests-per-minute limiter. Free tiers typically allow only a
 * handful of requests per minute, and exceeding them costs a slow retry, so
 * it is cheaper to pace requests locally. Implemented as a sliding window:
 * at most `rpm` calls may start within any 60 second period.
 */

import { sleep } from '../util/concurrency.js';

/** Limits the rate at which asynchronous operations may begin. */
export class RateLimiter {
  private readonly starts: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  /**
   * @param rpm - Maximum operations per rolling minute. `0` disables limiting.
   * @param now - Clock (injectable for tests).
   * @param sleepFn - Sleep (injectable for tests).
   */
  constructor(
    readonly rpm: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleepFn: (ms: number) => Promise<void> = sleep,
  ) {}

  /**
   * Resolves when the caller may proceed. Callers are served in FIFO order so
   * a burst of concurrent requests is spread evenly rather than racing.
   */
  acquire(): Promise<void> {
    if (this.rpm <= 0) return Promise.resolve();
    const ticket = this.queue.then(() => this.waitForSlot());
    // Keep the chain alive even if a waiter rejects (it cannot, but be safe).
    this.queue = ticket.catch(() => undefined);
    return ticket;
  }

  private async waitForSlot(): Promise<void> {
    const windowMs = 60_000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const t = this.now();
      while (this.starts.length && t - this.starts[0]! >= windowMs) this.starts.shift();
      if (this.starts.length < this.rpm) {
        this.starts.push(t);
        return;
      }
      const waitMs = windowMs - (t - this.starts[0]!) + 5;
      await this.sleepFn(waitMs);
    }
  }
}

/** Wraps an async function so every invocation first acquires from `limiter`. */
export function throttled<A extends unknown[], R>(
  limiter: RateLimiter,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    await limiter.acquire();
    return fn(...args);
  };
}
