/**
 * @module llm/provider
 *
 * Provider-agnostic contract for talking to a large language model.
 *
 * Every concrete adapter (`gemini.ts`, `openai-compatible.ts`, `anthropic.ts`,
 * `mock.ts`) implements {@link LlmProvider}. Higher layers (retry, throttle,
 * fallback) wrap providers without knowing which vendor is underneath.
 *
 * Errors are normalised into {@link LlmError} with a coarse {@link LlmErrorKind}
 * so retry and fallback logic can be written once.
 */

import type { ProviderId } from '../config/schema.js';

/** Metadata attached to a request so observers (logs, mock) know its purpose. */
export interface LlmRequestMeta {
  /** `analysis` for per-batch category prompts; `synthesis` for the final pass; `ping` for health checks. */
  kind: 'analysis' | 'synthesis' | 'ping';
  /** Category identifier for analysis requests. */
  category?: string;
  /** Human-readable label for logging (e.g. `batch 3/7`). */
  label?: string;
}

/** A single chat-style completion request. */
export interface LlmRequest {
  /** System prompt: role, rules, and output schema instructions. */
  system: string;
  /** User prompt: the material to analyse. */
  user: string;
  /**
   * Ask the provider for JSON output. Adapters use native JSON modes where
   * available and fall back to prompt instructions elsewhere; callers should
   * still run the result through `extractJson`.
   */
  jsonMode?: boolean;
  /** Per-request override of the configured output token limit. */
  maxOutputTokens?: number;
  /** Per-request override of the configured temperature. */
  temperature?: number;
  /** Abort signal propagated to `fetch`. */
  signal?: AbortSignal;
  /** Observability metadata. */
  meta?: LlmRequestMeta;
}

/** Token accounting for a single response. Values are provider-reported when available, otherwise estimated. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** True when the numbers were estimated locally instead of reported by the API. */
  estimated?: boolean;
}

/** A completed response. */
export interface LlmResponse {
  /** Raw text returned by the model. */
  text: string;
  usage: TokenUsage;
  /** Provider that actually served the request (relevant when fallbacks are in play). */
  provider: ProviderId;
  /** Model that actually served the request. */
  model: string;
  /** Wall-clock latency in milliseconds. */
  latencyMs: number;
}

/** Contract implemented by every LLM adapter. */
export interface LlmProvider {
  /** Stable identifier (matches the config `provider` value). */
  readonly id: ProviderId;
  /** Model this instance targets. */
  readonly model: string;
  /** Human-friendly label for logs and reports. */
  readonly label: string;
  /** Performs one completion. Must throw {@link LlmError} on failure. */
  complete(request: LlmRequest): Promise<LlmResponse>;
  /** Lightweight health check; resolves if credentials and endpoint work. */
  ping(): Promise<void>;
}

/**
 * Coarse error classification used by retry and fallback logic.
 *
 * - `auth`        401/403 or missing key. Not retryable; fallback-eligible.
 * - `rate_limit`  429 with a short window. Retryable with backoff.
 * - `quota`       Daily/monthly quota exhausted. Not retryable; fallback-eligible.
 * - `server`      5xx. Retryable.
 * - `network`     DNS/connection failures. Retryable, then fallback-eligible.
 * - `timeout`     Request exceeded `timeoutMs`. Retryable.
 * - `bad_request` 4xx other than above (bad model name, oversized prompt). Not retryable.
 * - `content`     Response blocked/filtered or empty. Not retryable.
 * - `unknown`     Anything else.
 */
export type LlmErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'server'
  | 'network'
  | 'timeout'
  | 'bad_request'
  | 'content'
  | 'unknown';

/** Normalised error thrown by all adapters. */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly provider: ProviderId;
  readonly status?: number;
  /** Server-suggested wait before retrying, when the provider sent one. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: { kind: LlmErrorKind; provider: ProviderId; status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'LlmError';
    this.kind = opts.kind;
    this.provider = opts.provider;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }

  /** Whether another attempt against the same provider may succeed. */
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'server' || this.kind === 'network' || this.kind === 'timeout';
  }

  /** Whether switching to a different provider is a sensible response. */
  get fallbackEligible(): boolean {
    return (
      this.kind === 'auth' ||
      this.kind === 'quota' ||
      this.kind === 'rate_limit' ||
      this.kind === 'server' ||
      this.kind === 'network' ||
      this.kind === 'timeout'
    );
  }
}

/**
 * Maps an HTTP status + body to an {@link LlmErrorKind}. Shared by adapters.
 * Quota exhaustion is detected heuristically from the body because providers
 * reuse 429 for both per-minute limits and daily quotas.
 */
export function classifyHttpError(status: number, body: string): LlmErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) {
    const lower = body.toLowerCase();
    if (/(quota|exhausted|daily|per day|insufficient_quota|billing|credit)/.test(lower)) return 'quota';
    return 'rate_limit';
  }
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

/** Parses a `Retry-After` header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Wraps a thrown value from `fetch` into an {@link LlmError}. Distinguishes
 * user aborts, timeouts, and network failures.
 */
export function wrapFetchError(err: unknown, provider: ProviderId): LlmError {
  if (err instanceof LlmError) return err;
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return new LlmError(`Request to ${provider} timed out or was aborted`, { kind: 'timeout', provider, cause: err });
  }
  const code = e?.code ?? e?.cause?.code;
  if (code && /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|UND_ERR)/.test(code)) {
    return new LlmError(`Network error reaching ${provider}: ${code}`, { kind: 'network', provider, cause: err });
  }
  if (e?.message && /fetch failed/i.test(e.message)) {
    return new LlmError(`Network error reaching ${provider}: ${e.message}`, { kind: 'network', provider, cause: err });
  }
  return new LlmError(`Unexpected error from ${provider}: ${e?.message ?? String(err)}`, {
    kind: 'unknown',
    provider,
    cause: err,
  });
}
