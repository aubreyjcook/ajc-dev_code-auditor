#!/usr/bin/env node
/**
 * @module cli
 *
 * Command-line entry point.
 *
 * ```
 * audit code <path|git-url> [options]   Audit a local directory or git repository
 * audit web  <url>          [options]   Crawl and audit a live website
 * audit providers                       Show provider configuration status and ping the active one
 * ```
 *
 * Flags map onto the configuration schema (see `config/schema.ts`); anything
 * not given on the command line falls back to `auditor.config.json`, then
 * environment variables, then built-in defaults.
 */

import { Command, InvalidArgumentError, Option } from 'commander';
import pc from 'picocolors';
import { loadConfig, ConfigError } from './config/load.js';
import { CATEGORY_IDS, PROVIDER_IDS, LOG_LEVELS, type CategoryId, type PartialAuditorConfig, type ProviderId } from './config/schema.js';
import { runAudit, toolInfo } from './audit.js';
import { renderTerminal } from './report/terminal.js';
import { CATEGORIES } from './analysis/categories.js';
import { PROVIDER_PRESETS, FREE_PROVIDER_ORDER, isProviderConfigured, getPreset } from './llm/presets.js';
import { createProvider, ProviderSetupError } from './llm/factory.js';
import { LlmError } from './llm/provider.js';
import { log, setLogLevel } from './util/logger.js';

/** Raw option bag produced by commander for the audit commands. */
interface AuditCliOptions {
  provider?: ProviderId;
  model?: string;
  baseUrl?: string;
  fallback?: ProviderId[];
  categories?: CategoryId[];
  rules?: string;
  out?: string;
  format?: ('markdown' | 'json')[];
  maxFiles?: number;
  maxFileBytes?: number;
  include?: string[];
  exclude?: string[];
  maxPages?: number;
  maxDepth?: number;
  timeout?: number;
  axe?: boolean;
  headless?: boolean;
  concurrency?: number;
  chunkTokens?: number;
  rpm?: number;
  synthesize?: boolean;
  dryRun?: boolean;
  failOn?: 'critical' | 'high' | 'medium' | 'low' | 'none';
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
  logLevel?: (typeof LOG_LEVELS)[number];
}

function parseInt10(name: string) {
  return (value: string): number => {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError(`${name} must be a non-negative integer`);
    return n;
  };
}

function parseList<T extends string>(allowed: readonly T[], name: string) {
  return (value: string, previous: T[] = []): T[] => {
    const parts = value.split(',').map((s) => s.trim()).filter(Boolean) as T[];
    for (const p of parts) {
      if (!allowed.includes(p)) throw new InvalidArgumentError(`Unknown ${name} "${p}". Allowed: ${allowed.join(', ')}`);
    }
    return [...previous, ...parts];
  };
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, ...value.split(',').map((s) => s.trim()).filter(Boolean)];
}

/** Adds the options shared by `code` and `web`. */
function addCommonOptions(cmd: Command): Command {
  return cmd
    .addOption(new Option('-p, --provider <id>', 'LLM provider').choices([...PROVIDER_IDS]))
    .option('-m, --model <name>', 'model identifier (defaults to the provider preset)')
    .option('--base-url <url>', 'override the provider base URL (required for openai-compatible)')
    .option('--fallback <providers>', 'comma-separated providers to try if the primary fails', parseList(PROVIDER_IDS, 'provider'))
    .option('-c, --categories <list>', `comma-separated categories (${CATEGORY_IDS.join(', ')})`, parseList(CATEGORY_IDS, 'category'))
    .option('-r, --rules <file>', 'custom rules file (enables the "custom" category)')
    .option('-o, --out <dir>', 'output directory (a timestamped sub-folder is created)')
    .option('--format <list>', 'report formats: markdown,json', parseList(['markdown', 'json'] as const, 'format'))
    .option('--concurrency <n>', 'parallel LLM requests (keep at 1 for free tiers)', parseInt10('concurrency'))
    .option('--chunk-tokens <n>', 'token budget per request', parseInt10('chunk-tokens'))
    .option('--rpm <n>', 'client-side requests-per-minute cap for the primary provider', parseInt10('rpm'))
    .option('--no-synthesize', 'skip the final narrative/merge pass (saves one request)')
    .option('--dry-run', 'use the offline mock provider; no API key or network needed')
    .addOption(
      new Option('--fail-on <severity>', 'exit with code 3 if any finding is at or above this severity (for CI gates)')
        .choices(['critical', 'high', 'medium', 'low', 'none'])
        .default('none'),
    )
    .option('--config <file>', 'path to a JSON config file (default: ./auditor.config.json)')
    .option('-v, --verbose', 'debug logging')
    .option('-q, --quiet', 'errors only')
    .addOption(new Option('--log-level <level>').choices([...LOG_LEVELS]).hideHelp());
}

/** Translates CLI options into a partial config for the loader. */
function toOverrides(o: AuditCliOptions): PartialAuditorConfig {
  const out: PartialAuditorConfig = {
    llm: {
      provider: o.provider,
      model: o.model,
      baseUrl: o.baseUrl,
      fallbackProviders: o.fallback,
      requestsPerMinute: o.rpm,
    },
    analysis: {
      categories: o.categories,
      customRulesFile: o.rules,
      concurrency: o.concurrency,
      chunkTokenBudget: o.chunkTokens,
      synthesize: o.synthesize === false ? false : undefined,
    },
    code: {
      maxFiles: o.maxFiles,
      maxFileBytes: o.maxFileBytes,
      include: o.include,
      exclude: o.exclude,
    },
    web: {
      maxPages: o.maxPages,
      maxDepth: o.maxDepth,
      timeoutMs: o.timeout,
      runAxe: o.axe === false ? false : undefined,
      headless: o.headless === false ? false : undefined,
    },
    output: {
      dir: o.out,
      formats: o.format,
    },
    logLevel: o.logLevel ?? (o.verbose ? 'debug' : o.quiet ? 'error' : undefined),
    dryRun: o.dryRun ? true : undefined,
  };
  return out;
}

async function runAuditCommand(kind: 'code' | 'web', source: string, o: AuditCliOptions): Promise<void> {
  let config;
  try {
    config = loadConfig({ configPath: o.config, cliOverrides: toOverrides(o) });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${pc.red('Configuration error:')} ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  setLogLevel(config.logLevel);

  log.info(`${toolInfo().name} v${toolInfo().version}`);

  try {
    const result = await runAudit({
      kind,
      source,
      config,
      onProgress: (done, total) => {
        if (total >= 10 && done % Math.max(1, Math.floor(total / 10)) === 0) log.info(`Progress: ${done}/${total} requests`);
      },
    });
    process.stdout.write(renderTerminal(result.report, { outputs: result.outputs }));

    // Optional CI gate: exit 3 when findings reach the threshold.
    // (Exit code 2 is reserved for configuration / provider errors.)
    if (o.failOn && o.failOn !== 'none' && !config.dryRun) {
      const order = ['critical', 'high', 'medium', 'low'] as const;
      const threshold = order.indexOf(o.failOn);
      const c = result.report.severityCounts;
      const hit = order.slice(0, threshold + 1).reduce((n, s) => n + c[s], 0);
      if (hit > 0) {
        process.stderr.write(pc.red(`${hit} finding(s) at or above "${o.failOn}" severity; failing as requested by --fail-on.\n`));
        process.exitCode = 3;
      }
    }
  } catch (err) {
    reportFatal(err);
  }
}

/** Prints a fatal error with provider-specific hints. */
function reportFatal(err: unknown): void {
  process.exitCode = 2;
  if (err instanceof ProviderSetupError) {
    process.stderr.write(`\n${pc.red('Provider not configured:')} ${err.message}\n`);
    process.stderr.write(pc.dim('Tip: run `audit providers` to see which providers are ready, or use --dry-run to test without an API key.\n'));
    return;
  }
  if (err instanceof LlmError) {
    process.stderr.write(`\n${pc.red(`LLM error (${err.provider}, ${err.kind}):`)} ${err.message}\n`);
    const hint = hintFor(err);
    if (hint) process.stderr.write(pc.dim(`${hint}\n`));
    return;
  }
  const e = err as Error;
  process.stderr.write(`\n${pc.red('Error:')} ${e.message}\n`);
  if (process.env.AUDITOR_LOG_LEVEL === 'debug' && e.stack) process.stderr.write(pc.dim(`${e.stack}\n`));
}

function hintFor(err: LlmError): string | undefined {
  const preset = getPreset(err.provider);
  switch (err.kind) {
    case 'auth':
      return `Check ${preset.apiKeyEnv ?? 'your credentials'}${preset.keyUrl ? ` (get a key at ${preset.keyUrl})` : ''}.`;
    case 'quota':
      return 'Daily/monthly quota exhausted. Try another free provider with --provider, or configure --fallback so the run continues automatically. See README "Free LLM providers".';
    case 'rate_limit':
      return 'Rate limited after retries. Lower --rpm, keep --concurrency 1, or switch providers.';
    case 'network':
      return preset.id === 'ollama' ? 'Is Ollama running? Start it with `ollama serve` and pull a model first.' : 'Check your network connection and any proxy settings.';
    case 'bad_request':
      return 'The model name may be wrong for this provider. Override with --model, or check the provider\'s model list.';
    default:
      return undefined;
  }
}

/** Implements `audit providers`. */
async function providersCommand(o: { ping?: boolean; provider?: ProviderId; config?: string }): Promise<void> {
  let config;
  try {
    config = loadConfig({ configPath: o.config, cliOverrides: o.provider ? { llm: { provider: o.provider } } : {} });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${pc.red('Configuration error:')} ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  setLogLevel('warn');

  const rows: string[] = [];
  rows.push(pc.bold('Providers') + pc.dim(`  (active: ${config.llm.provider}${config.llm.model ? ` / ${config.llm.model}` : ''}; fallbacks: ${config.llm.fallbackProviders.join(', ') || 'none'})`));
  rows.push('');
  for (const id of PROVIDER_IDS) {
    const p = PROVIDER_PRESETS[id];
    const ready = isProviderConfigured(id, id === config.llm.provider ? { apiKey: config.llm.apiKey, baseUrl: config.llm.baseUrl, model: config.llm.model } : {});
    const status = ready ? pc.green('ready  ') : pc.dim('not set');
    const free = p.freeTier ? pc.cyan('free') : pc.dim('paid');
    const active = id === config.llm.provider ? pc.yellow(' <- active') : '';
    rows.push(`${status} ${free} ${id.padEnd(18)} ${pc.dim(p.apiKeyEnv ? `${p.apiKeyEnv}` : 'no key needed')}${active}`);
    rows.push(`             ${pc.dim(`model: ${p.defaultModel ?? '(required)'}  rpm: ${p.defaultRequestsPerMinute || 'unlimited'}  ${p.notes}`)}`);
    if (p.keyUrl) rows.push(`             ${pc.dim(`key: ${p.keyUrl}`)}`);
  }
  rows.push('');
  rows.push(pc.dim(`Recommended free order: ${FREE_PROVIDER_ORDER.join(' -> ')}. Set AUDITOR_FALLBACK_PROVIDERS or --fallback to chain them.`));
  process.stdout.write(`${rows.join('\n')}\n`);

  if (o.ping !== false) {
    process.stdout.write(`\nPinging ${config.llm.provider}... `);
    try {
      const provider = createProvider({ id: config.llm.provider, llm: config.llm, applyOverrides: true });
      const started = Date.now();
      await provider.ping();
      process.stdout.write(pc.green(`ok (${provider.model}, ${Date.now() - started}ms)\n`));
    } catch (err) {
      process.stdout.write(pc.red('failed\n'));
      reportFatal(err);
    }
  }
}

/** Implements `audit categories`. */
function categoriesCommand(): void {
  const rows = CATEGORIES.map((c) => `${pc.bold(c.id.padEnd(14))} ${pc.dim(`[${c.appliesTo.join(', ')}]`.padEnd(13))} ${c.description}`);
  process.stdout.write(`${rows.join('\n')}\n`);
}

/** Builds the commander program. Exported for tests. */
export function buildProgram(): Command {
  const info = toolInfo();
  const program = new Command()
    .name('audit')
    .description('LLM-powered auditor for codebases and live websites.\nDefault provider is Google Gemini (free tier). Run `audit providers` to check setup.')
    .version(info.version)
    .showHelpAfterError();

  addCommonOptions(
    program
      .command('code')
      .argument('<path-or-git-url>', 'local directory or git clone URL')
      .description('audit a codebase')
      .option('--max-files <n>', 'cap on files analysed', parseInt10('max-files'))
      .option('--max-file-bytes <n>', 'skip files larger than this', parseInt10('max-file-bytes'))
      .option('--include <globs>', 'only include matching globs (comma-separated, repeatable)', collect)
      .option('--exclude <globs>', 'additional exclude globs (comma-separated, repeatable)', collect),
  ).action((source: string, o: AuditCliOptions) => runAuditCommand('code', source, o));

  addCommonOptions(
    program
      .command('web')
      .argument('<url>', 'start URL (https:// assumed if omitted)')
      .description('crawl and audit a live website or web app')
      .option('--max-pages <n>', 'maximum pages to crawl', parseInt10('max-pages'))
      .option('--max-depth <n>', 'maximum link depth from the start URL', parseInt10('max-depth'))
      .option('--timeout <ms>', 'per-page navigation timeout', parseInt10('timeout'))
      .option('--no-axe', 'skip axe-core accessibility checks')
      .option('--no-headless', 'show the browser while crawling'),
  ).action((url: string, o: AuditCliOptions) => runAuditCommand('web', url, o));

  program
    .command('providers')
    .description('list LLM providers, show which have credentials, and ping the active one')
    .addOption(new Option('-p, --provider <id>', 'provider to treat as active').choices([...PROVIDER_IDS]))
    .option('--no-ping', 'skip the connectivity check')
    .option('--config <file>', 'path to a JSON config file')
    .action((o) => providersCommand(o));

  program.command('categories').description('list analysis categories').action(categoriesCommand);

  return program;
}

// Only run when executed directly (not when imported by tests).
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ?? '';
    return /[\\/]cli\.(ts|js|mjs)$/.test(entry) || /[\\/]audit(\.cmd|\.ps1)?$/.test(entry) || /[\\/]\.bin[\\/]audit/.test(entry);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err) => {
      reportFatal(err);
    });
}
