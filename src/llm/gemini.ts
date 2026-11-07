/**
 * @module llm/gemini
 *
 * Adapter for the Google Generative Language API ("Gemini API"). This is the
 * default provider because its free tier needs no credit card.
 *
 * Endpoint: `POST {baseUrl}/models/{model}:generateContent`
 * Auth:     `x-goog-api-key` header
 * Docs:     https://ai.google.dev/api/generate-content
 */

import type { LlmProvider, LlmRequest, LlmResponse } from './provider.js';
import { LlmError } from './provider.js';
import { postJson, getJson } from './http.js';
import { estimateTokens } from './tokens.js';

/** Construction options for {@link GeminiProvider}. */
export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxOutputTokens: number;
  temperature: number;
  fetchFn?: typeof fetch;
}

/** Shape of the subset of the generateContent response we read. */
interface GenerateContentResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}

/** Gemini API adapter. */
export class GeminiProvider implements LlmProvider {
  readonly id = 'gemini' as const;
  readonly label = 'Google Gemini';
  readonly model: string;

  constructor(private readonly opts: GeminiProviderOptions) {
    this.model = opts.model;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const url = `${this.opts.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: {
        temperature: req.temperature ?? this.opts.temperature,
        maxOutputTokens: req.maxOutputTokens ?? this.opts.maxOutputTokens,
        ...(req.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
      // Code review legitimately discusses exploits; relax the default filters
      // so security findings are not silently blocked.
      safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map(
        (category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }),
      ),
    };

    const data = await postJson<GenerateContentResponse>({
      url,
      headers: { 'x-goog-api-key': this.opts.apiKey },
      body,
      timeoutMs: this.opts.timeoutMs,
      provider: this.id,
      signal: req.signal,
      fetchFn: this.opts.fetchFn,
    });

    if (data.promptFeedback?.blockReason) {
      throw new LlmError(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`, { kind: 'content', provider: this.id });
    }

    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    if (!text) {
      throw new LlmError(`Gemini returned no text (finishReason=${candidate?.finishReason ?? 'unknown'})`, {
        kind: 'content',
        provider: this.id,
      });
    }

    const usage = data.usageMetadata;
    return {
      text,
      usage: usage
        ? { inputTokens: usage.promptTokenCount ?? 0, outputTokens: usage.candidatesTokenCount ?? 0 }
        : { inputTokens: estimateTokens(req.system + req.user), outputTokens: estimateTokens(text), estimated: true },
      provider: this.id,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }

  /** Verifies the key by fetching the model's metadata (does not consume generation quota). */
  async ping(): Promise<void> {
    await getJson({
      url: `${this.opts.baseUrl}/models/${encodeURIComponent(this.model)}`,
      headers: { 'x-goog-api-key': this.opts.apiKey },
      timeoutMs: Math.min(this.opts.timeoutMs, 15_000),
      provider: this.id,
      fetchFn: this.opts.fetchFn,
    });
  }
}
