import { describe, it, expect, vi } from 'vitest';
import { LlmError, classifyHttpError, parseRetryAfter } from '../src/llm/provider.js';
import { withRetry, computeDelay } from '../src/llm/retry.js';
import { RateLimiter } from '../src/llm/throttle.js';
import { FallbackProvider } from '../src/llm/fallback.js';
import { MockProvider } from '../src/llm/mock.js';
import { createProvider, createProviderChain, ProviderSetupError } from '../src/llm/factory.js';
import { isProviderConfigured, getPreset } from '../src/llm/presets.js';
import { extractJson, JsonExtractionError } from '../src/llm/json.js';
import { GeminiProvider } from '../src/llm/gemini.js';
import { OpenAiCompatibleProvider } from '../src/llm/openai-compatible.js';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { LlmConfigSchema } from '../src/config/schema.js';
import { setLogLevel } from '../src/util/logger.js';

setLogLevel('silent');

const baseLlm = LlmConfigSchema.parse({});

describe('error classification', () => {
  it('maps statuses to kinds', () => {
    expect(classifyHttpError(401, '')).toBe('auth');
    expect(classifyHttpError(403, '')).toBe('auth');
    expect(classifyHttpError(429, 'Rate limit exceeded')).toBe('rate_limit');
    expect(classifyHttpError(429, 'You exceeded your current quota')).toBe('quota');
    expect(classifyHttpError(500, '')).toBe('server');
    expect(classifyHttpError(400, '')).toBe('bad_request');
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('7')).toBe(7000);
    expect(parseRetryAfter(null)).toBeUndefined();
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfter(future)!;
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it('flags retryable and fallback-eligible kinds', () => {
    expect(new LlmError('x', { kind: 'rate_limit', provider: 'gemini' }).retryable).toBe(true);
    expect(new LlmError('x', { kind: 'auth', provider: 'gemini' }).retryable).toBe(false);
    expect(new LlmError('x', { kind: 'auth', provider: 'gemini' }).fallbackEligible).toBe(true);
    expect(new LlmError('x', { kind: 'bad_request', provider: 'gemini' }).fallbackEligible).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries retryable errors and honours Retry-After', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new LlmError('429', { kind: 'rate_limit', provider: 'gemini', status: 429, retryAfterMs: 2000 });
        return 'ok';
      },
      { maxRetries: 3, sleepFn: async (ms) => void sleeps.push(ms) },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
    for (const s of sleeps) {
      expect(s).toBeGreaterThanOrEqual(2000);
      expect(s).toBeLessThan(2600);
    }
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new LlmError('401', { kind: 'auth', provider: 'gemini', status: 401 });
        },
        { maxRetries: 3, sleepFn: async () => undefined },
      ),
    ).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });

  it('gives up after maxRetries', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new LlmError('500', { kind: 'server', provider: 'gemini', status: 500 });
        },
        { maxRetries: 2, sleepFn: async () => undefined },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it('computes exponential delays capped at max', () => {
    expect(computeDelay(0, 1000, 60_000)).toBeGreaterThanOrEqual(1000);
    expect(computeDelay(10, 1000, 5000)).toBeLessThanOrEqual(5000);
  });
});

describe('RateLimiter', () => {
  it('allows rpm calls per minute and then waits', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = new RateLimiter(
      2,
      () => now,
      async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    );
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire(); // must wait for the window to pass
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(60_000);
  });

  it('is a no-op when rpm is 0', async () => {
    const limiter = new RateLimiter(0);
    for (let i = 0; i < 50; i++) await limiter.acquire();
  });
});

describe('FallbackProvider', () => {
  const managed = (provider: MockProvider) => ({ provider, limiter: new RateLimiter(0), maxRetries: 0 });

  it('advances to the next provider on auth errors and records the event', async () => {
    const bad = new MockProvider({ failWith: new LlmError('401 bad key', { kind: 'auth', provider: 'mock', status: 401 }) });
    const good = new MockProvider();
    const chain = new FallbackProvider([managed(bad), managed(good)]);
    const res = await chain.complete({ system: 's', user: 'u', meta: { kind: 'analysis', category: 'quality' } });
    expect(res.provider).toBe('mock');
    expect(bad.calls).toHaveLength(1);
    expect(good.calls).toHaveLength(1);
    expect(chain.events).toHaveLength(1);
    expect(chain.events[0]!.reason).toMatch(/auth/);
    // Subsequent calls go straight to the good provider.
    await chain.complete({ system: 's', user: 'u' });
    expect(bad.calls).toHaveLength(1);
    expect(good.calls).toHaveLength(2);
  });

  it('advances on rate limiting once retries are exhausted', async () => {
    const limited = new MockProvider({ failWith: new LlmError('429', { kind: 'rate_limit', provider: 'mock', status: 429, retryAfterMs: 1 }) });
    const good = new MockProvider();
    const chain = new FallbackProvider([
      { provider: limited, limiter: new RateLimiter(0), maxRetries: 1 },
      managed(good),
    ]);
    const res = await chain.complete({ system: 's', user: 'u' });
    expect(res.text).toBeTruthy();
    expect(limited.calls).toHaveLength(2); // initial + 1 retry
    expect(chain.events).toHaveLength(1);
  });

  it('propagates non-fallback-eligible errors', async () => {
    const bad = new MockProvider({ failWith: new LlmError('400', { kind: 'bad_request', provider: 'mock', status: 400 }) });
    const good = new MockProvider();
    const chain = new FallbackProvider([managed(bad), managed(good)]);
    await expect(chain.complete({ system: 's', user: 'u' })).rejects.toThrow(/400/);
    expect(good.calls).toHaveLength(0);
  });

  it('throws the last error when every provider fails', async () => {
    const a = new MockProvider({ failWith: new LlmError('quota', { kind: 'quota', provider: 'mock', status: 429 }) });
    const b = new MockProvider({ failWith: new LlmError('down', { kind: 'server', provider: 'mock', status: 503 }) });
    const chain = new FallbackProvider([managed(a), managed(b)]);
    await expect(chain.complete({ system: 's', user: 'u' })).rejects.toThrow(/down/);
  });
});

describe('factory and presets', () => {
  it('requires a key for gemini and names the env var', () => {
    expect(() => createProvider({ id: 'gemini', llm: baseLlm, applyOverrides: true, env: {} })).toThrowError(ProviderSetupError);
    expect(() => createProvider({ id: 'gemini', llm: baseLlm, applyOverrides: true, env: {} })).toThrow(/GEMINI_API_KEY/);
  });

  it('builds gemini with the preset default model', () => {
    const p = createProvider({ id: 'gemini', llm: baseLlm, applyOverrides: true, env: { GEMINI_API_KEY: 'k' } });
    expect(p).toBeInstanceOf(GeminiProvider);
    expect(p.model).toBe('gemini-3.5-flash-lite');
  });

  it('builds OpenAI-compatible presets with their base URLs and does not need a key for ollama', () => {
    const groq = createProvider({ id: 'groq', llm: baseLlm, applyOverrides: true, env: { GROQ_API_KEY: 'k' } });
    expect(groq).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(groq.model).toBe(getPreset('groq').defaultModel);
    const ollama = createProvider({ id: 'ollama', llm: baseLlm, applyOverrides: true, env: {} });
    expect(ollama.id).toBe('ollama');
  });

  it('requires baseUrl and model for openai-compatible', () => {
    expect(() => createProvider({ id: 'openai-compatible', llm: baseLlm, applyOverrides: true, env: {} })).toThrow(/model/);
    expect(() => createProvider({ id: 'openai-compatible', llm: { ...baseLlm, model: 'm' }, applyOverrides: true, env: {} })).toThrow(/base URL/);
    const ok = createProvider({ id: 'openai-compatible', llm: { ...baseLlm, model: 'm', baseUrl: 'http://localhost:1234/v1' }, applyOverrides: true, env: {} });
    expect(ok.model).toBe('m');
  });

  it('builds anthropic', () => {
    const p = createProvider({ id: 'anthropic', llm: baseLlm, applyOverrides: true, env: { ANTHROPIC_API_KEY: 'k' } });
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  it('isProviderConfigured reflects env keys', () => {
    expect(isProviderConfigured('gemini', {}, {})).toBe(false);
    expect(isProviderConfigured('gemini', {}, { GEMINI_API_KEY: 'k' })).toBe(true);
    expect(isProviderConfigured('ollama', {}, {})).toBe(true);
    expect(isProviderConfigured('mock', {}, {})).toBe(true);
  });

  it('createProviderChain skips unconfigured fallbacks and applies overrides only to the primary', () => {
    const chain = createProviderChain(
      { ...baseLlm, provider: 'gemini', model: 'custom-model', fallbackProviders: ['groq', 'openrouter', 'ollama', 'gemini'] },
      { GEMINI_API_KEY: 'k', GROQ_API_KEY: 'g' },
    );
    const ids = chain.providers.map((p) => p.id);
    expect(ids).toEqual(['gemini', 'groq', 'ollama']); // openrouter missing key; duplicate gemini dropped
    expect(chain.providers[0]!.model).toBe('custom-model');
    expect(chain.providers[1]!.model).toBe(getPreset('groq').defaultModel);
  });
});

describe('adapters (fetch stubbed)', () => {
  const okFetch = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })) as unknown as typeof fetch;

  it('gemini sends system instruction and parses usage', async () => {
    const fetchFn = okFetch({ candidates: [{ content: { parts: [{ text: '{"findings":[]}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    const p = new GeminiProvider({ apiKey: 'k', model: 'gemini-x', baseUrl: 'https://g', timeoutMs: 1000, maxOutputTokens: 100, temperature: 0, fetchFn });
    const res = await p.complete({ system: 'sys', user: 'usr', jsonMode: true });
    expect(res.text).toBe('{"findings":[]}');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(url).toContain('/models/gemini-x:generateContent');
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('gemini converts 429 with Retry-After into a rate_limit LlmError', async () => {
    const fetchFn = okFetch({ error: { message: 'Resource has been exhausted (e.g. check quota).' } }, 429, { 'retry-after': '12' });
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://g', timeoutMs: 1000, maxOutputTokens: 100, temperature: 0, fetchFn });
    try {
      await p.complete({ system: 's', user: 'u' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).kind).toBe('quota');
      expect((err as LlmError).retryAfterMs).toBe(12_000);
    }
  });

  it('openai-compatible posts chat completions and strips nothing from content', async () => {
    const fetchFn = okFetch({ choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
    const p = new OpenAiCompatibleProvider({ id: 'groq', label: 'Groq', apiKey: 'k', model: 'm', baseUrl: 'https://x/v1', timeoutMs: 1000, maxOutputTokens: 10, temperature: 0, supportsJsonMode: true, fetchFn });
    const res = await p.complete({ system: 's', user: 'u', jsonMode: true });
    expect(res.text).toBe('hello');
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://x/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('openai-compatible treats a 200 with an error object as a server error', async () => {
    const fetchFn = okFetch({ error: { message: 'upstream unavailable' } });
    const p = new OpenAiCompatibleProvider({ id: 'openrouter', label: 'OR', apiKey: 'k', model: 'm', baseUrl: 'https://x/v1', timeoutMs: 1000, maxOutputTokens: 10, temperature: 0, supportsJsonMode: false, fetchFn });
    await expect(p.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'server' });
  });

  it('anthropic prefills a brace in json mode and re-adds it', async () => {
    const fetchFn = okFetch({ content: [{ type: 'text', text: '"findings":[]}' }], usage: { input_tokens: 2, output_tokens: 2 } });
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://a/v1', timeoutMs: 1000, maxOutputTokens: 10, temperature: 0, fetchFn });
    const res = await p.complete({ system: 's', user: 'u', jsonMode: true });
    expect(res.text).toBe('{"findings":[]}');
  });

  it('network failures become network errors', async () => {
    const fetchFn = vi.fn(async () => {
      const e = new Error('fetch failed') as Error & { cause?: { code: string } };
      e.cause = { code: 'ECONNREFUSED' };
      throw e;
    }) as unknown as typeof fetch;
    const p = new OpenAiCompatibleProvider({ id: 'ollama', label: 'Ollama', model: 'm', baseUrl: 'http://localhost:11434/v1', timeoutMs: 1000, maxOutputTokens: 10, temperature: 0, supportsJsonMode: true, fetchFn });
    await expect(p.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips code fences and think blocks', () => {
    expect(extractJson('<think>hmm</think>\n```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
  });
  it('finds JSON embedded in prose', () => {
    expect(extractJson('Sure! Here it is: {"findings": [{"title": "x"}]} Hope that helps.')).toEqual({ findings: [{ title: 'x' }] });
  });
  it('handles braces inside strings', () => {
    expect(extractJson('{"s":"a } b { c","n":1}')).toEqual({ s: 'a } b { c', n: 1 });
  });
  it('repairs truncated output', () => {
    const out = extractJson<{ findings: { title: string }[] }>('{"findings":[{"title":"one"},{"title":"two"},{"tit');
    expect(out.findings.length).toBeGreaterThanOrEqual(2);
    expect(out.findings[0]!.title).toBe('one');
  });
  it('throws when nothing is parseable', () => {
    expect(() => extractJson('no json here')).toThrowError(JsonExtractionError);
  });
});
