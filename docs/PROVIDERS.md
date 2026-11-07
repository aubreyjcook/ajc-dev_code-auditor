# LLM providers

How the auditor talks to models, how errors are classified, and how to add a new host. For which free tier to pick and how to set keys, see the [README](../README.md#free-llm-providers-default-and-fallbacks).

## Interface

Every adapter implements `LlmProvider` (`src/llm/provider.ts`):

```ts
interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
  ping(): Promise<void>;
}
```

`LlmRequest` carries `system`, `user`, optional `jsonMode`, and `meta` (`kind: 'analysis' | 'synthesis' | 'ping'`, plus `category` / `label` for logs). `LlmResponse` is `{ text, usage: { inputTokens, outputTokens, estimated? } }`.

The rest of the pipeline never imports an adapter class. `createProvider` / `createProviderChain` in `src/llm/factory.ts` are the only constructors.

## Presets

`src/llm/presets.ts` is the static registry: protocol, base URL, env var names, default model, client-side RPM, whether JSON mode is honoured, signup URL, and a one-line note. Limits were checked in **November 2026** and will drift; they are set slightly *below* published free-tier caps so the synthesis request does not trip the server limiter.

`FREE_PROVIDER_ORDER` is `gemini → groq → openrouter → mistral → ollama`. It is what `audit providers` prints as the recommended chain.

## Adapters

### Gemini (`src/llm/gemini.ts`)

Native `POST {baseUrl}/models/{model}:generateContent` with `x-goog-api-key`. System instruction is a top-level field. JSON mode is `generationConfig.responseMimeType = "application/json"`. Usage comes from `usageMetadata.{promptTokenCount,candidatesTokenCount}`.

### OpenAI-compatible (`src/llm/openai-compatible.ts`)

`POST {baseUrl}/chat/completions` with `Authorization: Bearer`. Used by **groq, openrouter, mistral, ollama, openai, openai-compatible**. JSON mode is `response_format: { type: "json_object" }` when the preset's `supportsJsonMode` is true (OpenRouter free models skip it). A 200 body that contains an `error` object is treated as a server error. OpenRouter also sends `HTTP-Referer` / `X-Title` headers so the request is attributed.

### Anthropic (`src/llm/anthropic.ts`)

Messages API. JSON mode prefills the assistant turn with `{` and the adapter prepends it back onto the response, which reliably produces a JSON object from Claude.

### Mock (`src/llm/mock.ts`)

No network. Parses `### File:` / `### Page:` headings in the user prompt and emits one placeholder finding per item, with severities that cycle so reports have mixed counts. Synthesis returns a canned narrative. Used by `--dry-run` and tests. `MockProvider({ failWith, responder, latencyMs })` is injectable for unit tests.

## Error classification

`classifyHttpError(status, body, provider)` maps HTTP responses to `LlmError.kind`:

| Kind | Typical cause | `retryable` | `fallbackEligible` |
|---|---|---|---|
| `auth` | 401 / 403 | no | yes |
| `rate_limit` | 429 without quota language | yes | yes (after retries) |
| `quota` | 429 whose body mentions quota / daily / billing, or 403 with quota wording | no | yes |
| `server` | 5xx, or a 200 envelope with `error` | yes | yes |
| `network` | fetch failed (DNS, reset, ...) | yes | yes |
| `timeout` | abort after `timeoutMs` | yes | yes |
| `bad_request` | 400 (usually a wrong model id) | no | no |
| `content` | empty / unparseable model output | no | no |
| `unknown` | anything else | no | no |

`parseRetryAfter` reads the header as a delay-seconds or HTTP-date. `wrapFetchError` turns abort and network exceptions into `timeout` / `network`.

Quota vs rate-limit on 429 matters: a per-minute 429 should wait and retry against the *same* provider; a daily-quota 429 should skip to the next fallback immediately.

## Retry

`withRetry(fn, { maxRetries, baseDelayMs, maxDelayMs, label })` wraps a single provider call. Only `retryable` errors are retried. Delay is `Retry-After` if present, otherwise exponential backoff with jitter, capped at `maxDelayMs`. After `maxRetries` (default 4, from `llm.maxRetries`) the error is rethrown for the fallback chain to see.

## Throttle

Each `ManagedProvider` has its own `RateLimiter(rpm)`. `acquire()` sleeps until the sliding one-minute window has a free slot. `rpm === 0` (Ollama, mock) is a no-op. The primary's RPM comes from `--rpm` / `llm.requestsPerMinute` if set, otherwise the preset.

## Fallback chain

`FallbackProvider` holds the chain in order: primary, then each of `fallbackProviders` that `isProviderConfigured` (has a key if required, a base URL, and a model). Unconfigured fallbacks are skipped with an info log, not an error.

On `fallbackEligible` after retries:

1. Record a `FallbackEvent` `{ from, to, kind, message, at }`.
2. Permanently advance. Subsequent requests in the same run never return to an earlier provider.
3. Retry the *current* request on the new provider.

If the chain is exhausted, the original error is thrown and the CLI exits 2 with a hint (`hintFor` in `cli.ts`).

User overrides (`model`, `baseUrl`, `apiKey`) apply only to the primary (`applyOverrides: true`). Fallbacks always use their own preset + env. That way `-m gemini-3.5-flash` does not get sent to Groq.

`--dry-run` short-circuits all of this: provider is forced to `mock`, fallbacks cleared.

## JSON extraction

Models are asked for a JSON object but often wrap it in fences, `<think>` blocks, or prose. `extractJson` (`src/llm/json.ts`):

1. Strips markdown fences and think-blocks.
2. Finds the first balanced `{...}` (strings and escapes respected).
3. `JSON.parse`s it.
4. On unbalanced input (typical of `max_tokens` truncation), `repairTruncated` repeatedly closes open strings/structures and, if that still fails, cuts back to the previous `,` / `{` / `[` and tries again. Complete findings emitted before the cut are salvaged.

`parseAnalysisResponse` / `parseSynthesisResponse` then validate with zod: extra keys ignored, unknown severities dropped, confidence clamped to 0..1.

## `audit providers`

Lists every id with `ready` / `not set`, `free` / `paid`, env var, default model, RPM, notes, and key URL. Marks the configured primary. Then pings it (`provider.ping()`, a tiny `complete` with `meta.kind = 'ping'`) unless `--no-ping`.

## Adding a provider

If it speaks OpenAI chat completions:

1. Add the id to `PROVIDER_IDS` in `src/config/schema.ts`.
2. Add a `PROVIDER_PRESETS` entry with `protocol: 'openai'`, `baseUrl` including `/v1`, `apiKeyEnv`, `defaultModel`, `defaultRequestsPerMinute`, `supportsJsonMode`, `freeTier`, `keyUrl`, `notes`.
3. If it is a recommended free option, append it to `FREE_PROVIDER_ORDER`.
4. Document it in the README free-providers section.

No factory change is required; `protocol: 'openai'` already constructs `OpenAiCompatibleProvider`.

If it needs a different wire format, add an adapter class with the same constructor shape as `GeminiProvider`, a `protocol` value, and a `switch` case in `createProvider`. Keep retry/throttle/fallback out of the adapter — they wrap it.

## Testing adapters

`tests/llm.test.ts` stubs `fetch` and covers:

- Gemini request shape + usage parsing + 429/`Retry-After` → `rate_limit`
- OpenAI-compatible chat completions + 200-with-error-object
- Anthropic `{` prefill
- Network failures → `network`
- `extractJson` (plain, fenced, embedded, truncated)
- `FallbackProvider` advancing after retries
- Factory skipping unconfigured fallbacks and applying overrides only to the primary
