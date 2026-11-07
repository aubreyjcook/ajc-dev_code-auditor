/**
 * @module analysis/analyzer
 *
 * Runs every enabled category over every batch of material and collects the
 * findings. Per-batch failures are recorded rather than aborting the run, so
 * a single bad response (or an exhausted quota late in the run) still yields
 * a partial report.
 *
 * Request volume is `batches x perBatchCategories + onceCategories`, which
 * on the free Gemini tier (~10 RPM) means a 400-file project takes a few
 * minutes. The `--concurrency` flag can raise parallelism for providers
 * with higher limits.
 */

import type { AnalysisConfig, CategoryId } from '../config/schema.js';
import type { LlmProvider, LlmResponse } from '../llm/provider.js';
import type { ScanResult } from '../scanners/types.js';
import type { CategoryResult, Finding } from '../report/types.js';
import { resolveCategories, type CategoryDefinition } from './categories.js';
import { chunkItems, sampleItems } from './chunker.js';
import type { Batch, PromptContext } from './prompts/types.js';
import { parseAnalysisResponse, toFinding } from './schema.js';
import { UsageTracker } from './usage.js';
import { mapLimit } from '../util/concurrency.js';
import { log } from '../util/logger.js';

/** Options for {@link analyze}. */
export interface AnalyzeOptions {
  scan: ScanResult;
  provider: LlmProvider;
  config: AnalysisConfig;
  /** Contents of the custom rules file, if any. */
  customRules?: string;
  /** Progress callback (completed, total). */
  onProgress?: (done: number, total: number, label: string) => void;
  /** Shared usage tracker (so synthesis can add to it). */
  usage?: UsageTracker;
}

/** Output of {@link analyze}. */
export interface AnalyzeResult {
  /** Findings without ids assigned yet. */
  findings: Finding[];
  categories: CategoryResult[];
  /** Per-category free-text notes from the model. */
  categoryNotes: Record<string, string[]>;
  usage: UsageTracker;
  warnings: string[];
  batchCount: number;
}

/** One unit of LLM work. */
interface Job {
  category: CategoryDefinition;
  batch: Batch;
  batchCount: number;
}

/** Runs the analysis phase. */
export async function analyze(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const { scan, provider, config } = opts;
  const usage = opts.usage ?? new UsageTracker();
  const warnings: string[] = [];

  const { run, skipped } = resolveCategories(config.categories, scan.target.kind, Boolean(opts.customRules));
  const results = new Map<CategoryId, CategoryResult>();
  for (const s of skipped) {
    if (s.reason === 'not requested') continue;
    results.set(s.id, { category: s.id, status: 'skipped', findingCount: 0, batchesRun: 0, batchesFailed: 0, notes: [], reason: s.reason });
  }

  if (!scan.items.length) {
    warnings.push('No material was collected; nothing to analyse.');
    return { findings: [], categories: [...results.values()], categoryNotes: {}, usage, warnings, batchCount: 0 };
  }

  const chunkOpts = { tokenBudget: config.chunkTokenBudget };
  const batches = chunkItems(scan.items, chunkOpts);
  const sample = sampleItems(scan.items, chunkOpts);

  const jobs: Job[] = [];
  for (const category of run) {
    results.set(category.id, { category: category.id, status: 'completed', findingCount: 0, batchesRun: 0, batchesFailed: 0, notes: [] });
    if (category.perBatch) {
      for (const batch of batches) jobs.push({ category, batch, batchCount: batches.length });
    } else {
      jobs.push({ category, batch: sample, batchCount: 1 });
    }
  }

  log.info(`Analysis plan: ${batches.length} batch(es) x ${run.filter((c) => c.perBatch).length} per-batch categories + ${run.filter((c) => !c.perBatch).length} sampled = ${jobs.length} request(s) via ${provider.label} (${provider.model})`);

  const findings: Finding[] = [];
  const categoryNotes: Record<string, string[]> = {};
  let done = 0;

  await mapLimit(jobs, config.concurrency, async (job) => {
    const label = `${job.category.id} batch ${job.batch.index + 1}/${job.batchCount}`;
    const result = results.get(job.category.id)!;
    try {
      const ctx: PromptContext = {
        targetKind: scan.target.kind,
        targetLabel: scan.target.resolved,
        batch: job.batch,
        batchCount: job.batchCount,
        tech: scan.tech,
        ownership: scan.ownership,
        gitAuthors: scan.gitAuthors,
        customRules: opts.customRules,
        scanNotes: scan.notes,
      };
      const prompt = job.category.prompt(ctx);
      const res: LlmResponse = await provider.complete({
        system: prompt.system,
        user: prompt.user,
        jsonMode: true,
        meta: { kind: 'analysis', category: job.category.id, label },
      });
      usage.record(res);

      const parsed = parseAnalysisResponse(res.text);
      if (parsed.dropped) warnings.push(`${label}: ${parsed.dropped} malformed finding(s) dropped`);
      const producedBy = `${res.provider}/${res.model}`;
      const itemIds = job.batch.items.map((i) => i.id);
      for (const raw of parsed.findings) findings.push(toFinding(raw, job.category.id, producedBy, itemIds));
      if (parsed.notes.length) (categoryNotes[job.category.id] ??= []).push(...parsed.notes);
      result.batchesRun++;
      result.findingCount += parsed.findings.length;
      log.step(`${label}: ${parsed.findings.length} finding(s) [${res.provider}/${res.model}, ${res.latencyMs}ms]`);
    } catch (err) {
      result.batchesFailed++;
      const message = (err as Error).message;
      warnings.push(`${label} failed: ${message}`);
      log.warn(`${label} failed: ${message}`);
    } finally {
      done++;
      opts.onProgress?.(done, jobs.length, label);
    }
  });

  for (const r of results.values()) {
    if (r.status !== 'completed') continue;
    if (r.batchesRun === 0 && r.batchesFailed > 0) r.status = 'failed';
    else if (r.batchesFailed > 0) r.status = 'partial';
    r.notes = categoryNotes[r.category] ?? [];
  }

  return {
    findings,
    categories: orderCategories([...results.values()]),
    categoryNotes,
    usage,
    warnings,
    batchCount: batches.length,
  };
}

/** Orders category results to match the registry order. */
function orderCategories(results: CategoryResult[]): CategoryResult[] {
  const order: CategoryId[] = ['security', 'quality', 'performance', 'accessibility', 'architecture', 'technology', 'ownership', 'custom'];
  return results.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
}
