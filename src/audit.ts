/**
 * @module audit
 *
 * End-to-end pipeline: scan -> analyse -> synthesise -> report. This is the
 * function the CLI calls, and the one to import when using the auditor
 * programmatically.
 *
 * ```ts
 * import { runAudit, loadConfig } from 'ajc-dev-code-auditor';
 * const { report } = await runAudit({ kind: 'code', source: './my-repo', config: loadConfig() });
 * ```
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AuditorConfig } from './config/schema.js';
import { createProviderChain } from './llm/factory.js';
import type { FallbackProvider } from './llm/fallback.js';
import { scanCode } from './scanners/code/index.js';
import { scanWeb } from './scanners/web/index.js';
import type { ScanResult } from './scanners/types.js';
import { analyze } from './analysis/analyzer.js';
import { synthesize } from './analysis/synthesize.js';
import { UsageTracker } from './analysis/usage.js';
import type { AuditReport, Severity } from './report/types.js';
import { writeReports } from './report/write.js';
import { log } from './util/logger.js';

/** Options for {@link runAudit}. */
export interface RunAuditOptions {
  kind: 'code' | 'web';
  /** Directory, git URL, or website URL. */
  source: string;
  config: AuditorConfig;
  /** Working directory for relative paths. */
  cwd?: string;
  /** Skip writing files (return the report only). */
  noWrite?: boolean;
  /** Pre-built provider (tests); otherwise built from `config.llm`. */
  provider?: FallbackProvider;
  /** Progress callback for long analysis phases. */
  onProgress?: (done: number, total: number, label: string) => void;
}

/** Result of {@link runAudit}. */
export interface RunAuditResult {
  report: AuditReport;
  scan: ScanResult;
  /** Paths of files written (empty when `noWrite`). */
  outputs: string[];
  outputDir?: string;
}

/** Package name/version for the report header. */
export function toolInfo(): { name: string; version: string } {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { name: string; version: string };
    return { name: pkg.name, version: pkg.version };
  } catch {
    return { name: 'ajc-dev-code-auditor', version: '0.0.0' };
  }
}

/** Runs a complete audit. */
export async function runAudit(opts: RunAuditOptions): Promise<RunAuditResult> {
  const started = Date.now();
  const cwd = opts.cwd ?? process.cwd();
  const { config } = opts;
  const warnings: string[] = [];

  // 1. Provider chain is built first so credential problems fail fast,
  //    before a potentially slow crawl or clone.
  const provider = opts.provider ?? createProviderChain(config.llm);
  if (provider.providers.length > 1) {
    log.info(`Provider chain: ${provider.providers.map((p) => `${p.id}/${p.model}`).join(' -> ')}`);
  } else {
    log.info(`Provider: ${provider.label} (${provider.model})${config.dryRun ? ' [dry run]' : ''}`);
  }

  // 2. Custom rules.
  let customRules: string | undefined;
  if (config.analysis.customRulesFile) {
    const rulesPath = path.resolve(cwd, config.analysis.customRulesFile);
    customRules = await readFile(rulesPath, 'utf8');
    log.info(`Custom rules loaded from ${rulesPath} (${customRules.length} chars)`);
  }

  // 3. Scan.
  const scan =
    opts.kind === 'code'
      ? await scanCode({ source: opts.source, config: config.code, cwd })
      : await scanWeb({ url: opts.source, config: config.web });

  // 4. Analyse.
  const usage = new UsageTracker();
  const analysis = await analyze({ scan, provider, config: config.analysis, customRules, usage, onProgress: opts.onProgress });
  warnings.push(...analysis.warnings);

  // 5. Synthesise.
  const synth = await synthesize({
    scan,
    findings: analysis.findings,
    categoryNotes: analysis.categoryNotes,
    provider,
    usage,
    skipLlm: !config.analysis.synthesize,
  });
  warnings.push(...synth.warnings);

  // 6. Assemble report.
  const severityCounts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of synth.findings) severityCounts[f.severity]++;

  const report: AuditReport = {
    schemaVersion: 1,
    generatedAt: new Date(started).toISOString(),
    tool: toolInfo(),
    target: scan.target,
    llm: {
      primaryProvider: config.llm.provider,
      primaryModel: provider.providers[0]!.model,
      providersUsed: usage.providersUsed,
      fallbacks: provider.events,
      dryRun: config.dryRun,
    },
    scan: { ...scan.stats, notes: scan.notes },
    categories: analysis.categories.map((c) => ({ ...c, findingCount: synth.findings.filter((f) => f.category === c.category).length })),
    narrative: synth.narrative,
    findings: synth.findings,
    severityCounts,
    technology: scan.tech,
    ownership: scan.ownership,
    gitAuthors: scan.gitAuthors,
    usage: usage.summary(),
    warnings,
    durationMs: Date.now() - started,
  };

  // 7. Write.
  if (opts.noWrite) return { report, scan, outputs: [] };
  const written = await writeReports({ report, output: config.output, cwd });
  return { report, scan, outputs: written.files, outputDir: written.dir };
}
