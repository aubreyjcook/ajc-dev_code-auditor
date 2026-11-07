/**
 * @module llm/anthropic
 *
 * Adapter for the Anthropic Messages API.
 *
 * Endpoint: `POST {baseUrl}/messages`
 * Auth:     `x-api-key` header plus `anthropic-version`
 * Docs:     https://docs.anthropic.com/en/api/messages
 */

import type { LlmProvider, LlmRequest, LlmResponse } from './provider.js';
import { LlmError } from './provider.js';
import { postJson, getJson } from './http.js';
import { estimateTokens } from './tokens.js';

/** Construction options for {@link AnthropicProvider}. */
export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxOutputTokens: number;
  temperature: number;
  fetchFn?: typeof fetch;
}

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic Messages adapter. */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  readonly label = 'Anthropic';
  readonly model: string;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.model = opts.model;
  }

  private headers(): Record<string, string> {
    return { 'x-api-key': this.opts.apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    // Anthropic has no JSON mode flag; prefilling the assistant turn with `{`
    // reliably coerces JSON output. We re-add the brace to the returned text.
    const prefill = req.jsonMode ? '{' : undefined;
    const messages: unknown[] = [{ role: 'user', content: req.user }];
    if (prefill) messages.push({ role: 'assistant', content: prefill });

    const data = await postJson<MessagesResponse>({
      url: `${this.opts.baseUrl}/messages`,
      headers: this.headers(),
      body: {
        model: this.model,
        system: req.system,
        messages,
        max_tokens: req.maxOutputTokens ?? this.opts.maxOutputTokens,
        temperature: req.temperature ?? this.opts.temperature,
      },
      timeoutMs: this.opts.timeoutMs,
      provider: this.id,
      signal: req.signal,
      fetchFn: this.opts.fetchFn,
    });

    const body = (data.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    if (!body.trim()) {
      throw new LlmError(`Anthropic returned empty content (stop_reason=${data.stop_reason ?? 'unknown'})`, {
        kind: 'content',
        provider: this.id,
      });
    }
    const text = prefill ? prefill + body : body;

    return {
      text,
      usage: data.usage
        ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 }
        : { inputTokens: estimateTokens(req.system + req.user), outputTokens: estimateTokens(text), estimated: true },
      provider: this.id,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }

  async ping(): Promise<void> {
    await getJson({
      url: `${this.opts.baseUrl}/models/${encodeURIComponent(this.model)}`,
      headers: this.headers(),
      timeoutMs: Math.min(this.opts.timeoutMs, 15_000),
      provider: this.id,
      fetchFn: this.opts.fetchFn,
    });
  }
}
