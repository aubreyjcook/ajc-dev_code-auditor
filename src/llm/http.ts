/**
 * @module llm/http
 *
 * Thin `fetch` wrapper shared by the HTTP-based adapters. Handles timeouts,
 * abort propagation, and conversion of HTTP failures into {@link LlmError}.
 */

import type { ProviderId } from '../config/schema.js';
import { LlmError, classifyHttpError, parseRetryAfter, wrapFetchError } from './provider.js';

/** Options for {@link postJson}. */
export interface PostJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  provider: ProviderId;
  signal?: AbortSignal;
  /** Injected `fetch` for tests. */
  fetchFn?: typeof fetch;
}

/**
 * POSTs a JSON body and returns the parsed JSON response. Throws
 * {@link LlmError} for non-2xx statuses, timeouts, and network failures.
 */
export async function postJson<T = unknown>(opts: PostJsonOptions): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), opts.timeoutMs);
  const onOuterAbort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const doFetch = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (err) {
    throw wrapFetchError(err, opts.provider);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }

  const text = await res.text();
  if (!res.ok) {
    const kind = classifyHttpError(res.status, text);
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    throw new LlmError(`${opts.provider} responded ${res.status}: ${summarise(text)}`, {
      kind,
      provider: opts.provider,
      status: res.status,
      retryAfterMs,
    });
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LlmError(`${opts.provider} returned non-JSON body: ${summarise(text)}`, {
      kind: 'unknown',
      provider: opts.provider,
      status: res.status,
    });
  }
}

/** Performs a GET and returns parsed JSON; used by `ping()` implementations. */
export async function getJson<T = unknown>(opts: Omit<PostJsonOptions, 'body'>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), opts.timeoutMs);
  const doFetch = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(opts.url, { method: 'GET', headers: opts.headers, signal: controller.signal });
  } catch (err) {
    throw wrapFetchError(err, opts.provider);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new LlmError(`${opts.provider} responded ${res.status}: ${summarise(text)}`, {
      kind: classifyHttpError(res.status, text),
      provider: opts.provider,
      status: res.status,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LlmError(`${opts.provider} returned non-JSON body`, { kind: 'unknown', provider: opts.provider });
  }
}

/** Collapses an error body to a single short line for messages. */
function summarise(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}
