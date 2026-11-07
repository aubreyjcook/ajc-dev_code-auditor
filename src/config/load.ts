/**
 * @module config/load
 *
 * Builds the effective {@link AuditorConfig} by layering, in increasing
 * precedence:
 *
 *   defaults  <  environment variables  <  config file  <  CLI overrides
 *
 * Each layer is validated with {@link PartialAuditorConfigSchema} so a typo in
 * one place produces a clear error that names the offending layer.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import {
  AuditorConfigSchema,
  PartialAuditorConfigSchema,
  type AuditorConfig,
  type PartialAuditorConfig,
  type ProviderId,
  PROVIDER_IDS,
  type LogLevel,
  LOG_LEVELS,
} from './schema.js';

/** Default config file name looked up in the current working directory. */
export const DEFAULT_CONFIG_FILENAME = 'auditor.config.json';

/** Options accepted by {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Explicit path to a JSON config file. Defaults to `./auditor.config.json` if present. */
  configPath?: string;
  /** Directory whose `.env` and config file should be consulted. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Overrides from CLI flags; highest precedence. */
  cliOverrides?: PartialAuditorConfig;
  /** Environment to read from (injectable for tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Skip loading `.env` from disk (tests). */
  skipDotenv?: boolean;
}

/** Thrown when any configuration layer fails validation. */
export class ConfigError extends Error {
  constructor(message: string, readonly layer: 'env' | 'file' | 'cli' | 'merged') {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Loads and merges all configuration layers.
 *
 * @example
 * ```ts
 * const cfg = loadConfig({ cliOverrides: { llm: { provider: 'groq' } } });
 * console.log(cfg.llm.provider); // 'groq'
 * ```
 */
export function loadConfig(options: LoadConfigOptions = {}): AuditorConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  if (!options.skipDotenv) {
    // `.env` is loaded without overriding variables already present in the
    // shell, matching the behaviour users expect from dotenv.
    loadDotenv({ path: path.join(cwd, '.env'), quiet: true });
  }

  const envLayer = validateLayer(configFromEnv(env), 'env');
  const fileLayer = validateLayer(configFromFile(options.configPath, cwd), 'file');
  const cliLayer = validateLayer(options.cliOverrides ?? {}, 'cli');

  const merged = deepMerge(deepMerge(deepMerge({}, envLayer), fileLayer), cliLayer);

  const result = AuditorConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration:\n${formatZodIssues(result.error.issues)}`, 'merged');
  }

  // `--dry-run` always forces the mock provider so no credentials are needed.
  if (result.data.dryRun) {
    result.data.llm.provider = 'mock';
    result.data.llm.fallbackProviders = [];
  }

  return result.data;
}

/**
 * Translates `AUDITOR_*` environment variables into a partial config.
 * Provider API keys are intentionally *not* copied here; adapters read them
 * directly so they never end up serialised into reports or logs.
 */
export function configFromEnv(env: NodeJS.ProcessEnv): PartialAuditorConfig {
  const out: PartialAuditorConfig = {};

  const provider = env.AUDITOR_PROVIDER?.trim();
  const model = env.AUDITOR_MODEL?.trim();
  const baseUrl = env.AUDITOR_BASE_URL?.trim();
  const fallbacks = env.AUDITOR_FALLBACK_PROVIDERS?.trim();
  const rpm = env.AUDITOR_REQUESTS_PER_MINUTE?.trim();
  if (provider || model || baseUrl || fallbacks || rpm) {
    out.llm = {};
    if (provider) out.llm.provider = provider as ProviderId;
    if (model) out.llm.model = model;
    if (baseUrl) out.llm.baseUrl = baseUrl;
    if (fallbacks) out.llm.fallbackProviders = parseList(fallbacks) as ProviderId[];
    if (rpm !== undefined && rpm !== '') out.llm.requestsPerMinute = Number(rpm);
  }

  const concurrency = env.AUDITOR_CONCURRENCY?.trim();
  if (concurrency) out.analysis = { concurrency: Number(concurrency) };

  const outDir = env.AUDITOR_OUT_DIR?.trim();
  if (outDir) out.output = { dir: outDir };

  const logLevel = env.AUDITOR_LOG_LEVEL?.trim();
  if (logLevel) out.logLevel = logLevel as LogLevel;

  return out;
}

/**
 * Reads the JSON config file if it exists. A missing default file is not an
 * error; a missing *explicit* `--config` path is.
 */
export function configFromFile(configPath: string | undefined, cwd: string): PartialAuditorConfig {
  const resolved = configPath ? path.resolve(cwd, configPath) : path.join(cwd, DEFAULT_CONFIG_FILENAME);

  if (!existsSync(resolved)) {
    if (configPath) throw new ConfigError(`Config file not found: ${resolved}`, 'file');
    return {};
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Could not parse ${resolved}: ${(err as Error).message}`, 'file');
  }

  if (raw && typeof raw === 'object' && '$comment' in raw) {
    delete (raw as Record<string, unknown>).$comment;
  }
  return raw as PartialAuditorConfig;
}

/** Validates a single layer, attributing errors to it. */
function validateLayer(layer: unknown, name: 'env' | 'file' | 'cli'): PartialAuditorConfig {
  const result = PartialAuditorConfigSchema.safeParse(layer);
  if (!result.success) {
    throw new ConfigError(
      `Invalid configuration in ${describeLayer(name)}:\n${formatZodIssues(result.error.issues)}`,
      name,
    );
  }
  return stripUndefined(result.data) as PartialAuditorConfig;
}

function describeLayer(name: 'env' | 'file' | 'cli'): string {
  switch (name) {
    case 'env':
      return `environment variables (valid providers: ${PROVIDER_IDS.join(', ')}; log levels: ${LOG_LEVELS.join(', ')})`;
    case 'file':
      return 'config file';
    case 'cli':
      return 'CLI flags';
  }
}

/** Formats zod issues as an indented bullet list. */
export function formatZodIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `  - ${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('\n');
}

/** Splits a comma/whitespace separated list, dropping empties. */
function parseList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Removes `undefined` values recursively so that an unset CLI flag never
 * clobbers a value from a lower-precedence layer during the merge.
 */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Recursively merges plain objects. Arrays and primitives in `source`
 * replace those in `target` wholesale (so `categories` from a higher layer
 * fully overrides the lower layer rather than concatenating).
 */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const existing = out[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
