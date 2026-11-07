/**
 * @module llm/factory
 *
 * Builds concrete providers from configuration and assembles the fallback
 * chain. This is the only module that needs to know about every adapter.
 */

import type { LlmConfig, ProviderId } from '../config/schema.js';
import { GeminiProvider } from './gemini.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';
import { MockProvider } from './mock.js';
import { FallbackProvider, type ManagedProvider } from './fallback.js';
import { RateLimiter } from './throttle.js';
import { getPreset, isProviderConfigured, resolveApiKey, resolveBaseUrl, type ProviderPreset } from './presets.js';
import type { LlmProvider } from './provider.js';
import { log } from '../util/logger.js';

/** Options for {@link createProvider}. */
export interface CreateProviderOptions {
  /** Provider to build. */
  id: ProviderId;
  llm: LlmConfig;
  /**
   * When building the *primary* provider, the user's `model`/`baseUrl`/`apiKey`
   * overrides apply. Fallback providers always use their preset defaults
   * (plus env) because the overrides belong to the primary.
   */
  applyOverrides: boolean;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

/** Thrown when a provider cannot be built (missing key, missing base URL, ...). */
export class ProviderSetupError extends Error {
  constructor(message: string, readonly provider: ProviderId) {
    super(message);
    this.name = 'ProviderSetupError';
  }
}

/** Builds a single provider instance from config + env. */
export function createProvider(opts: CreateProviderOptions): LlmProvider {
  const env = opts.env ?? process.env;
  const preset = getPreset(opts.id);
  const explicitModel = opts.applyOverrides ? opts.llm.model : undefined;
  const explicitBaseUrl = opts.applyOverrides ? opts.llm.baseUrl : undefined;
  const explicitKey = opts.applyOverrides ? opts.llm.apiKey : undefined;

  const model = explicitModel ?? preset.defaultModel;
  if (!model) {
    throw new ProviderSetupError(`Provider "${opts.id}" requires an explicit model (--model or llm.model)`, opts.id);
  }

  const common = {
    model,
    timeoutMs: opts.llm.timeoutMs,
    maxOutputTokens: opts.llm.maxOutputTokens,
    temperature: opts.llm.temperature,
    fetchFn: opts.fetchFn,
  };

  switch (preset.protocol) {
    case 'mock':
      return new MockProvider();

    case 'gemini': {
      const apiKey = requireKey(preset, explicitKey, env);
      const baseUrl = requireBaseUrl(preset, explicitBaseUrl, env);
      return new GeminiProvider({ ...common, apiKey, baseUrl });
    }

    case 'anthropic': {
      const apiKey = requireKey(preset, explicitKey, env);
      const baseUrl = requireBaseUrl(preset, explicitBaseUrl, env);
      return new AnthropicProvider({ ...common, apiKey, baseUrl });
    }

    case 'openai': {
      const baseUrl = requireBaseUrl(preset, explicitBaseUrl, env);
      const apiKey = preset.apiKeyEnv ? resolveApiKey(preset, explicitKey, env) : undefined;
      if (preset.apiKeyEnv && !apiKey && preset.id !== 'openai-compatible') {
        throw missingKey(preset);
      }
      const extraHeaders: Record<string, string> = {};
      if (preset.id === 'openrouter') {
        // OpenRouter uses these for attribution; harmless elsewhere but we keep them scoped.
        extraHeaders['HTTP-Referer'] = 'https://github.com/ajc-dev/code-auditor';
        extraHeaders['X-Title'] = 'ajc-dev code auditor';
      }
      return new OpenAiCompatibleProvider({
        ...common,
        id: preset.id,
        label: preset.label,
        apiKey,
        baseUrl,
        supportsJsonMode: preset.supportsJsonMode,
        extraHeaders,
      });
    }
  }
}

/**
 * Builds the primary provider and any configured fallbacks, each wrapped in
 * its own rate limiter, and returns a {@link FallbackProvider}.
 *
 * Fallbacks that are not configured (no key in the environment) are skipped
 * with a debug log rather than failing the run; the user will be told at
 * the end which providers were actually available.
 */
export function createProviderChain(llm: LlmConfig, env: NodeJS.ProcessEnv = process.env, fetchFn?: typeof fetch): FallbackProvider {
  const chain: ManagedProvider[] = [];

  const primary = createProvider({ id: llm.provider, llm, applyOverrides: true, env, fetchFn });
  chain.push({
    provider: primary,
    limiter: new RateLimiter(llm.requestsPerMinute ?? getPreset(llm.provider).defaultRequestsPerMinute),
    maxRetries: llm.maxRetries,
  });

  for (const id of llm.fallbackProviders) {
    if (id === llm.provider) continue;
    if (!isProviderConfigured(id, {}, env)) {
      log.debug(`Fallback provider "${id}" skipped: not configured (set ${getPreset(id).apiKeyEnv ?? 'base URL'})`);
      continue;
    }
    try {
      const provider = createProvider({ id, llm, applyOverrides: false, env, fetchFn });
      chain.push({
        provider,
        limiter: new RateLimiter(getPreset(id).defaultRequestsPerMinute),
        maxRetries: llm.maxRetries,
      });
    } catch (err) {
      log.debug(`Fallback provider "${id}" skipped: ${(err as Error).message}`);
    }
  }

  return new FallbackProvider(chain);
}

function requireKey(preset: ProviderPreset, explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  const key = resolveApiKey(preset, explicit, env);
  if (!key) throw missingKey(preset);
  return key;
}

function requireBaseUrl(preset: ProviderPreset, explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  const url = resolveBaseUrl(preset, explicit, env);
  if (!url) {
    throw new ProviderSetupError(
      `Provider "${preset.id}" requires a base URL (--base-url, llm.baseUrl, or ${preset.baseUrlEnv})`,
      preset.id,
    );
  }
  return url;
}

function missingKey(preset: ProviderPreset): ProviderSetupError {
  const where = preset.keyUrl ? ` Get one at ${preset.keyUrl}.` : '';
  return new ProviderSetupError(
    `No API key for ${preset.label}. Set ${preset.apiKeyEnv} in your environment or .env file.${where}`,
    preset.id,
  );
}
