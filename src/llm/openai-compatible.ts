/**
 * @module llm/openai-compatible
 *
 * Adapter for any endpoint that implements the OpenAI Chat Completions API.
 * One class serves Groq, OpenRouter, Mistral, Ollama, OpenAI itself, and
 * arbitrary self-hosted servers (vLLM, LM Studio, ...). The differences
 * between them are captured in `presets.ts` (base URL, key, JSON-mode
 * support) rather than in code.
 *
 * Endpoint: `POST {baseUrl}/chat/completions`
 * Auth:     `Authorization: Bearer <key>` (omitted when no key is configured)
 */

import type { ProviderId } from '../config/schema.js';
import type { LlmProvider, LlmRequest, LlmResponse } from './provider.js';
import { LlmError } from './provider.js';
import { postJson, getJson } from './http.js';
import { estimateTokens } from './tokens.js';

/** Construction options for {@link OpenAiCompatibleProvider}. */
export interface OpenAiCompatibleOptions {
  /** Provider id this instance represents (e.g. `groq`). */
  id: ProviderId;
  label: string;
  apiKey?: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxOutputTokens: number;
  temperature: number;
  /** Send `response_format: { type: "json_object" }` when `jsonMode` is requested. */
  supportsJsonMode: boolean;
  /** Extra headers (OpenRouter likes `HTTP-Referer` / `X-Title`). */
  extraHeaders?: Record<string, string>;
  fetchFn?: typeof fetch;
}

/** Subset of the chat completion response we read. */
interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null; reasoning?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** Chat Completions adapter. */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly model: string;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.id = opts.id;
    this.label = opts.label;
    this.model = opts.model;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { ...(this.opts.extraHeaders ?? {}) };
    if (this.opts.apiKey) h.authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      temperature: req.temperature ?? this.opts.temperature,
      max_tokens: req.maxOutputTokens ?? this.opts.maxOutputTokens,
      stream: false,
    };
    if (req.jsonMode && this.opts.supportsJsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const data = await postJson<ChatCompletionResponse>({
      url: `${this.opts.baseUrl}/chat/completions`,
      headers: this.headers(),
      body,
      timeoutMs: this.opts.timeoutMs,
      provider: this.id,
      signal: req.signal,
      fetchFn: this.opts.fetchFn,
    });

    // Some gateways return 200 with an error object (OpenRouter does this for
    // upstream failures). Treat that as a server error so retry/fallback apply.
    if (data.error?.message) {
      throw new LlmError(`${this.label} error: ${data.error.message}`, { kind: 'server', provider: this.id });
    }

    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? '';
    if (!text.trim()) {
      throw new LlmError(`${this.label} returned empty content (finish_reason=${choice?.finish_reason ?? 'unknown'})`, {
        kind: 'content',
        provider: this.id,
      });
    }

    return {
      text,
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
        : { inputTokens: estimateTokens(req.system + req.user), outputTokens: estimateTokens(text), estimated: true },
      provider: this.id,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }

  /** Lists models to verify connectivity and credentials. */
  async ping(): Promise<void> {
    await getJson({
      url: `${this.opts.baseUrl}/models`,
      headers: this.headers(),
      timeoutMs: Math.min(this.opts.timeoutMs, 15_000),
      provider: this.id,
      fetchFn: this.opts.fetchFn,
    });
  }
}
