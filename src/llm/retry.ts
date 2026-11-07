/**
 * @module llm/retry
 *
 * Exponential backoff with jitter for transient LLM failures. Honours the
 * server's `Retry-After` hint when present, which matters on free tiers where
 * the hint can be tens of seconds.
 */

import { LlmError } from './provider.js';
import { sleep } from '../util/concurrency.js';
import { log } from '../util/logger.js';

/** Options for {@link withRetry}. */
export interface RetryOptions {
  /** Maximum number of retries after the initial attempt. */
  maxRetries: number;
  /** Base delay for the first retry (doubles each attempt). */
  baseDelayMs?: number;
  /** Ceiling for any single computed delay. */
  maxDelayMs?: number;
  /** Label used in log lines. */
  label?: string;
  /** Injected for tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Invokes `fn` until it succeeds, a non-retryable error is thrown, or
 * `maxRetries` is exhausted. Only {@link LlmError} instances with
 * `retryable === true` trigger a retry; everything else propagates at once.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const baseDelay = opts.baseDelayMs ?? 1500;
  const maxDelay = opts.maxDelayMs ?? 60_000;
  const doSleep = opts.sleepFn ?? sleep;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!(err instanceof LlmError) || !err.retryable || attempt >= opts.maxRetries) {
        throw err;
      }
      const delay = computeDelay(attempt, baseDelay, maxDelay, err.retryAfterMs);
      log.warn(
        `${opts.label ?? err.provider}: ${err.kind} (${err.status ?? 'n/a'}) - retry ${attempt + 1}/${opts.maxRetries} in ${Math.round(delay / 1000)}s`,
      );
      await doSleep(delay);
      attempt++;
    }
  }
}

/**
 * Computes the next delay. `Retry-After` wins when present (plus a little
 * jitter so parallel workers do not stampede); otherwise exponential backoff.
 */
export function computeDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, retryAfterMs?: number): number {
  const jitter = Math.random() * 500;
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(maxDelayMs, retryAfterMs + jitter);
  }
  return Math.min(maxDelayMs, baseDelayMs * 2 ** attempt + jitter);
}
