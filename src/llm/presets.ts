/**
 * @module llm/presets
 *
 * Static knowledge about each supported provider: where its API lives, which
 * environment variable holds the key, which model to use by default, and a
 * client-side requests-per-minute ceiling tuned to its free tier.
 *
 * Free-tier numbers were checked in November 2026 and drift over time. They
 * are deliberately a little below the published limits so bursts from the
 * synthesis pass do not trip the server-side limiter. Users can override any
 * of them via `llm.model`, `llm.baseUrl`, and `llm.requestsPerMinute`.
 */

import type { ProviderId } from '../config/schema.js';

/** Which wire protocol an adapter speaks. */
export type ProviderProtocol = 'gemini' | 'openai' | 'anthropic' | 'mock';

/** Static description of a provider. */
export interface ProviderPreset {
  id: ProviderId;
  /** Display name. */
  label: string;
  protocol: ProviderProtocol;
  /** Base URL for the API (OpenAI-compatible presets include the `/v1`). */
  baseUrl?: string;
  /** Environment variable that holds the API key; `undefined` when no key is needed. */
  apiKeyEnv?: string;
  /** Environment variable that may override the base URL. */
  baseUrlEnv?: string;
  /** Default model when the user does not specify one. */
  defaultModel?: string;
  /** Client-side RPM ceiling; `0` disables throttling. */
  defaultRequestsPerMinute: number;
  /** Whether the preset has a usable free tier (for `audit providers` output and docs). */
  freeTier: boolean;
  /** Whether the endpoint honours OpenAI's `response_format: { type: "json_object" }`. */
  supportsJsonMode: boolean;
  /** Where to obtain a key. */
  keyUrl?: string;
  /** One-line note shown by `audit providers`. */
  notes: string;
}

/** Registry of presets, keyed by provider id. */
export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GEMINI_API_KEY',
    baseUrlEnv: 'GEMINI_BASE_URL',
    // Flash-Lite has a far higher free daily quota (~500 RPD) than Flash (~20 RPD),
    // which matters because one audit issues many requests.
    defaultModel: 'gemini-3.5-flash-lite',
    defaultRequestsPerMinute: 8,
    freeTier: true,
    supportsJsonMode: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    notes: 'Default. Free tier, no card. Free-tier prompts may be used by Google to improve products.',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    baseUrlEnv: 'GROQ_BASE_URL',
    defaultModel: 'openai/gpt-oss-120b',
    defaultRequestsPerMinute: 25,
    freeTier: true,
    supportsJsonMode: true,
    keyUrl: 'https://console.groq.com/keys',
    notes: 'Free tier ~30 RPM / 1,000 RPD / 8k TPM. Very fast. Phone verification at signup.',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    defaultModel: 'openai/gpt-oss-120b:free',
    defaultRequestsPerMinute: 15,
    freeTier: true,
    supportsJsonMode: false,
    keyUrl: 'https://openrouter.ai/keys',
    notes: 'Any model ending in ":free". ~20 RPM / 50 RPD on the free plan; free list rotates weekly.',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    protocol: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    baseUrlEnv: 'MISTRAL_BASE_URL',
    defaultModel: 'mistral-small-latest',
    defaultRequestsPerMinute: 30,
    freeTier: true,
    supportsJsonMode: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
    notes: 'Free "experiment" tier (~1 request/second). Requires phone verification.',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    defaultModel: 'qwen2.5-coder:7b',
    defaultRequestsPerMinute: 0,
    freeTier: true,
    supportsJsonMode: true,
    keyUrl: 'https://ollama.com/download',
    notes: 'Fully local and private; no key or rate limits. Run `ollama pull qwen2.5-coder:7b` first.',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    defaultModel: 'gpt-4o-mini',
    defaultRequestsPerMinute: 60,
    freeTier: false,
    supportsJsonMode: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    notes: 'Paid. Usage billed per token.',
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    protocol: 'openai',
    apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
    baseUrlEnv: 'OPENAI_COMPATIBLE_BASE_URL',
    defaultRequestsPerMinute: 30,
    freeTier: false,
    supportsJsonMode: false,
    notes: 'Bring your own base URL and model (LM Studio, vLLM, Together, Fireworks, Cerebras, ...).',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    defaultModel: 'claude-haiku-4-5',
    defaultRequestsPerMinute: 50,
    freeTier: false,
    supportsJsonMode: false,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    notes: 'Paid. Usage billed per token.',
  },
  mock: {
    id: 'mock',
    label: 'Mock (offline)',
    protocol: 'mock',
    defaultModel: 'mock-1',
    defaultRequestsPerMinute: 0,
    freeTier: true,
    supportsJsonMode: true,
    notes: 'Deterministic canned responses. Used by tests and --dry-run.',
  },
};

/** Returns the preset for a provider id. */
export function getPreset(id: ProviderId): ProviderPreset {
  return PROVIDER_PRESETS[id];
}

/** Providers that have a usable free tier, in the order we recommend trying them. */
export const FREE_PROVIDER_ORDER: ProviderId[] = ['gemini', 'groq', 'openrouter', 'mistral', 'ollama'];

/**
 * Resolves the API key for a provider from explicit config or the preset's
 * environment variable. Returns `undefined` when none is configured.
 */
export function resolveApiKey(preset: ProviderPreset, explicit: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (explicit) return explicit;
  if (!preset.apiKeyEnv) return undefined;
  const v = env[preset.apiKeyEnv]?.trim();
  return v ? v : undefined;
}

/** Resolves the base URL for a provider from config, env, or preset. */
export function resolveBaseUrl(preset: ProviderPreset, explicit: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (explicit) return explicit.replace(/\/+$/, '');
  const fromEnv = preset.baseUrlEnv ? env[preset.baseUrlEnv]?.trim() : undefined;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  return preset.baseUrl;
}

/**
 * Returns true when the provider has everything it needs to be attempted:
 * a key if one is required, and a base URL.
 */
export function isProviderConfigured(
  id: ProviderId,
  opts: { apiKey?: string; baseUrl?: string; model?: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const preset = getPreset(id);
  if (preset.protocol === 'mock') return true;
  if (preset.apiKeyEnv && !resolveApiKey(preset, opts.apiKey, env)) return false;
  if (!resolveBaseUrl(preset, opts.baseUrl, env)) return false;
  if (!preset.defaultModel && !opts.model) return false;
  return true;
}
