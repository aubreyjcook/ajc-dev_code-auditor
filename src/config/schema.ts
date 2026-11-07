/**
 * @module config/schema
 *
 * Zod schema and TypeScript types for the auditor's configuration.
 *
 * The configuration is assembled from four layers (highest precedence first):
 *
 *   1. CLI flags            (`--provider`, `--model`, `--max-pages`, ...)
 *   2. `auditor.config.json` in the current working directory (or `--config`)
 *   3. Environment variables (`AUDITOR_*`, provider API keys)
 *   4. Built-in defaults declared in this file
 *
 * `config/load.ts` performs the merge; this file only describes the shape and
 * defaults so the schema can be reused for validation of each layer.
 */

import { z } from 'zod';

/**
 * Identifiers for every LLM provider the auditor knows how to talk to.
 *
 * - `gemini`            Google Generative Language API (default; free tier).
 * - `groq`, `openrouter`, `mistral`, `ollama`, `openai`
 *                       Presets for the generic OpenAI-compatible adapter.
 * - `openai-compatible` Generic adapter with a user-supplied `baseUrl`.
 * - `anthropic`         Anthropic Messages API.
 * - `mock`              Deterministic offline provider used by tests and `--dry-run`.
 */
export const PROVIDER_IDS = [
  'gemini',
  'groq',
  'openrouter',
  'mistral',
  'ollama',
  'openai',
  'openai-compatible',
  'anthropic',
  'mock',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Analysis categories. Each one maps to a prompt in `analysis/prompts/` and a
 * section in the final report. `accessibility` only applies to web targets;
 * `custom` is enabled implicitly when a custom rules file is supplied.
 */
export const CATEGORY_IDS = [
  'security',
  'quality',
  'performance',
  'accessibility',
  'architecture',
  'technology',
  'ownership',
  'custom',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const OUTPUT_FORMATS = ['markdown', 'json'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** LLM connection and sampling settings. */
export const LlmConfigSchema = z.object({
  /** Primary provider used for every request. */
  provider: z.enum(PROVIDER_IDS).default('gemini'),
  /**
   * Model identifier passed to the provider. When omitted, the provider
   * preset's default free model is used (see `llm/presets.ts`).
   */
  model: z.string().min(1).optional(),
  /** Overrides the preset base URL (required for `openai-compatible`). */
  baseUrl: z.string().url().optional(),
  /**
   * Explicit API key. Normally left unset so the key is read from the
   * provider-specific environment variable (e.g. `GEMINI_API_KEY`).
   */
  apiKey: z.string().min(1).optional(),
  /**
   * Ordered list of providers to try when the primary fails with an
   * authentication, quota, or network error. Providers without credentials
   * configured are skipped automatically.
   */
  fallbackProviders: z.array(z.enum(PROVIDER_IDS)).default([]),
  /**
   * Requests-per-minute ceiling enforced client-side. `null` uses the preset
   * default for the provider (tuned for its free tier). `0` disables the
   * client-side limiter.
   */
  requestsPerMinute: z.number().int().min(0).nullable().default(null),
  /** Upper bound on tokens the model may generate per request. */
  maxOutputTokens: z.number().int().positive().default(4096),
  /** Sampling temperature. Low values keep findings deterministic. */
  temperature: z.number().min(0).max(2).default(0.1),
  /** Per-request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(120_000),
  /** Maximum retry attempts for transient (429 / 5xx / network) failures. */
  maxRetries: z.number().int().min(0).default(4),
});

export type LlmConfig = z.infer<typeof LlmConfigSchema>;

/** Settings governing how collected material is analysed. */
export const AnalysisConfigSchema = z.object({
  /** Categories to run. Inapplicable categories (e.g. accessibility on code) are skipped. */
  categories: z
    .array(z.enum(CATEGORY_IDS))
    .default(['security', 'quality', 'performance', 'accessibility', 'architecture', 'technology', 'ownership']),
  /** Path to a Markdown/text file of user-defined rules; enables the `custom` category. */
  customRulesFile: z.string().nullable().default(null),
  /**
   * Approximate token budget for the material included in a single LLM
   * request. Kept conservative so free-tier TPM limits are respected.
   */
  chunkTokenBudget: z.number().int().min(2000).default(24_000),
  /** Number of LLM requests allowed in flight simultaneously. */
  concurrency: z.number().int().min(1).max(16).default(1),
  /** Run the final synthesis pass (executive summary, dedupe). */
  synthesize: z.boolean().default(true),
});

export type AnalysisConfig = z.infer<typeof AnalysisConfigSchema>;

/** Settings specific to codebase targets. */
export const CodeConfigSchema = z.object({
  /** Hard cap on files sent to the LLM (largest/most relevant are kept). */
  maxFiles: z.number().int().positive().default(400),
  /** Files larger than this are skipped (minified bundles, data dumps, ...). */
  maxFileBytes: z.number().int().positive().default(200_000),
  /** Additional glob patterns to include (applied after built-in ignores). */
  include: z.array(z.string()).default([]),
  /** Additional glob patterns to exclude. */
  exclude: z.array(z.string()).default([]),
});

export type CodeConfig = z.infer<typeof CodeConfigSchema>;

/** Settings specific to live website targets. */
export const WebConfigSchema = z.object({
  /** Maximum number of pages to crawl (same origin only). */
  maxPages: z.number().int().positive().default(10),
  /** Maximum link depth from the start URL. */
  maxDepth: z.number().int().min(0).default(2),
  /** Per-page navigation timeout. */
  timeoutMs: z.number().int().positive().default(30_000),
  /** Run axe-core accessibility checks on each page. */
  runAxe: z.boolean().default(true),
  /** User-Agent header for the crawler. */
  userAgent: z.string().default('ajc-dev-code-auditor/0.1 (+https://github.com/ajc-dev)'),
  /** Run the browser headless (set false to watch the crawl). */
  headless: z.boolean().default(true),
});

export type WebConfig = z.infer<typeof WebConfigSchema>;

/** Where and how reports are written. */
export const OutputConfigSchema = z.object({
  /** Root output directory; a timestamped sub-folder is created per run. */
  dir: z.string().default('./audit-output'),
  /** Report formats to write. The terminal summary is always printed. */
  formats: z.array(z.enum(OUTPUT_FORMATS)).default(['markdown', 'json']),
});

export type OutputConfig = z.infer<typeof OutputConfigSchema>;

/** Top-level configuration object. */
export const AuditorConfigSchema = z.object({
  llm: LlmConfigSchema.default(() => LlmConfigSchema.parse({})),
  analysis: AnalysisConfigSchema.default(() => AnalysisConfigSchema.parse({})),
  code: CodeConfigSchema.default(() => CodeConfigSchema.parse({})),
  web: WebConfigSchema.default(() => WebConfigSchema.parse({})),
  output: OutputConfigSchema.default(() => OutputConfigSchema.parse({})),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  /**
   * When true, no real LLM is contacted: the `mock` provider is substituted
   * and the whole pipeline (scan, chunk, prompt, report) still runs.
   */
  dryRun: z.boolean().default(false),
});

export type AuditorConfig = z.infer<typeof AuditorConfigSchema>;

/**
 * Produces an all-optional version of an object schema with every `.default()`
 * removed. Zod's `.partial()` keeps defaults, which would make each config
 * layer "fill in" values and clobber lower-precedence layers during the
 * merge; this strips them so an absent key stays absent.
 */
function partialWithoutDefaults<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const inner = field instanceof z.ZodDefault ? (field as z.ZodDefault<z.ZodTypeAny>).removeDefault() : (field as z.ZodTypeAny);
    shape[key] = inner.optional();
  }
  return z.object(shape) as z.ZodObject<{ [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer U> ? U : T[K]> }>;
}

/**
 * Deep-partial variant used for individual layers before merging. Each layer
 * only contributes the keys it explicitly sets; defaults are applied once,
 * to the merged result, by {@link AuditorConfigSchema}.
 */
export const PartialAuditorConfigSchema = z.object({
  llm: partialWithoutDefaults(LlmConfigSchema).optional(),
  analysis: partialWithoutDefaults(AnalysisConfigSchema).optional(),
  code: partialWithoutDefaults(CodeConfigSchema).optional(),
  web: partialWithoutDefaults(WebConfigSchema).optional(),
  output: partialWithoutDefaults(OutputConfigSchema).optional(),
  logLevel: z.enum(LOG_LEVELS).optional(),
  dryRun: z.boolean().optional(),
});

export type PartialAuditorConfig = z.infer<typeof PartialAuditorConfigSchema>;

/** Built-in defaults, materialised once for reuse. */
export const DEFAULT_CONFIG: AuditorConfig = AuditorConfigSchema.parse({});
