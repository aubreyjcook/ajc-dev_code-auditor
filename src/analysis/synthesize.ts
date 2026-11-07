/**
 * @module analysis/synthesize
 *
 * Post-processing after all category batches have run:
 *
 *  1. Deterministic de-duplication (same category + normalised title +
 *     location) and stable id assignment (`SEC-001`, ...).
 *  2. One LLM call that writes the narrative sections and proposes further
 *     duplicate groups the heuristics could not see.
 *  3. Merge the proposed groups, keeping the most severe entry.
 *
 * If the synthesis call fails (quota exhausted, provider down), the report
 * still ships with deterministic fallbacks for every narrative section.
 */

import type { LlmProvider } from '../llm/provider.js';
import type { ScanResult } from '../scanners/types.js';
import type { Finding, Narrative, Severity } from '../report/types.js';
import { severityRank } from '../report/types.js';
import { getCategory } from './categories.js';
import { synthesisPrompt } from './prompts/synthesis.js';
import { parseSynthesisResponse } from './schema.js';
import { UsageTracker } from './usage.js';
import { log } from '../util/logger.js';

/** Options for {@link synthesize}. */
export interface SynthesizeOptions {
  scan: ScanResult;
  findings: Finding[];
  categoryNotes: Record<string, string[]>;
  provider: LlmProvider;
  usage: UsageTracker;
  /** Skip the LLM call and use deterministic narrative only. */
  skipLlm?: boolean;
}

/** Output of {@link synthesize}. */
export interface SynthesizeResult {
  findings: Finding[];
  narrative: Narrative;
  warnings: string[];
}

/** Runs de-duplication, id assignment, and the narrative pass. */
export async function synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
  const warnings: string[] = [];
  let findings = assignIds(dedupeHeuristically(opts.findings));

  const fallback = deterministicNarrative(opts.scan, findings, opts.categoryNotes);
  if (opts.skipLlm) return { findings, narrative: fallback, warnings };

  try {
    const prompt = synthesisPrompt({
      target: opts.scan.target,
      findings,
      tech: opts.scan.tech,
      ownership: opts.scan.ownership,
      gitAuthors: opts.scan.gitAuthors,
      categoryNotes: opts.categoryNotes,
      scanNotes: opts.scan.notes,
      stats: { items: opts.scan.stats.itemsScanned, tokens: opts.scan.stats.totalTokens },
    });
    const res = await opts.provider.complete({
      system: prompt.system,
      user: prompt.user,
      jsonMode: true,
      maxOutputTokens: 6000,
      meta: { kind: 'synthesis', label: 'synthesis' },
    });
    opts.usage.record(res);
    const parsed = parseSynthesisResponse(res.text);

    if (parsed.duplicateGroups.length) {
      const before = findings.length;
      findings = mergeGroups(findings, parsed.duplicateGroups);
      log.step(`synthesis merged ${before - findings.length} duplicate finding(s)`);
    }

    const narrative: Narrative = {
      executiveSummary: parsed.executiveSummary || fallback.executiveSummary,
      architectureOverview: parsed.architectureOverview || fallback.architectureOverview,
      technologySummary: parsed.technologySummary || fallback.technologySummary,
      ownershipSummary: parsed.ownershipSummary || fallback.ownershipSummary,
      topRisks: parsed.topRisks.length ? parsed.topRisks : fallback.topRisks,
    };
    return { findings, narrative, warnings };
  } catch (err) {
    const message = (err as Error).message;
    warnings.push(`Synthesis pass failed; narrative sections were generated deterministically. (${message})`);
    log.warn(`Synthesis failed: ${message}`);
    return { findings, narrative: fallback, warnings };
  }
}

/**
 * Collapses findings that share category, normalised title, and location.
 * Keeps the entry with the highest severity (then confidence) and records
 * the merge in `mergedFrom` once ids exist.
 */
export function dedupeHeuristically(findings: Finding[]): Finding[] {
  const map = new Map<string, Finding>();
  for (const f of findings) {
    const key = [f.category, normaliseTitle(f.title), f.location.file ?? f.location.url ?? '', f.location.line ?? ''].join('|');
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...f });
      continue;
    }
    map.set(key, pickBetter(existing, f));
  }
  return [...map.values()];
}

/** Sorts by severity then category and assigns `PREFIX-NNN` ids. */
export function assignIds(findings: Finding[]): Finding[] {
  const sorted = [...findings].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.category.localeCompare(b.category) || b.confidence - a.confidence || a.title.localeCompare(b.title),
  );
  const counters = new Map<string, number>();
  for (const f of sorted) {
    const prefix = getCategory(f.category).idPrefix;
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    f.id = `${prefix}-${String(n).padStart(3, '0')}`;
  }
  return sorted;
}

/** Merges id groups proposed by the synthesis model. */
export function mergeGroups(findings: Finding[], groups: string[][]): Finding[] {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const removed = new Set<string>();
  for (const group of groups) {
    const members = group.map((id) => byId.get(id)).filter((f): f is Finding => !!f && !removed.has(f.id));
    if (members.length < 2) continue;
    // Refuse cross-category merges; the model is told not to, but be safe.
    const category = members[0]!.category;
    const same = members.filter((m) => m.category === category);
    if (same.length < 2) continue;
    let keeper = same[0]!;
    for (const m of same.slice(1)) keeper = pickBetter(keeper, m); // pickBetter records mergedFrom
    for (const m of same) if (m !== keeper) removed.add(m.id);
  }
  return findings.filter((f) => !removed.has(f.id));
}

function pickBetter(a: Finding, b: Finding): Finding {
  const aRank = severityRank(a.severity);
  const bRank = severityRank(b.severity);
  const keep = aRank < bRank || (aRank === bRank && a.confidence >= b.confidence) ? a : b;
  const other = keep === a ? b : a;
  // Preserve the richer evidence/recommendation when the keeper lacks them.
  if (!keep.evidence && other.evidence) keep.evidence = other.evidence;
  if (!keep.recommendation && other.recommendation) keep.recommendation = other.recommendation;
  if (other.id && keep.id && other.id !== keep.id) keep.mergedFrom = [...(keep.mergedFrom ?? []), other.id];
  return keep;
}

function normaliseTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Narrative built without the model; used when synthesis is skipped or fails. */
export function deterministicNarrative(scan: ScanResult, findings: Finding[], notes: Record<string, string[]>): Narrative {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const kind = scan.target.kind === 'code' ? 'codebase' : 'website';

  const executiveSummary = [
    `Automated audit of the ${kind} at ${scan.target.resolved}.`,
    `${scan.stats.itemsScanned} item(s) were analysed, producing ${findings.length} finding(s): ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.info} informational.`,
    counts.critical + counts.high > 0 ? 'Critical and high severity findings should be reviewed first.' : 'No critical or high severity findings were reported.',
  ].join(' ');

  const topRisks = findings
    .filter((f) => f.severity === 'critical' || f.severity === 'high')
    .slice(0, 5)
    .map((f) => `${f.id}: ${f.title}`);

  const techLines = scan.tech.slice(0, 40).map((t) => `- ${t.name}${t.version ? ` ${t.version}` : ''} (${t.category})`);
  const technologySummary = (notes.technology?.join('\n\n') || '') + (techLines.length ? `\n\nDetected deterministically:\n${techLines.join('\n')}` : '');

  const archNotes = notes.architecture?.join('\n\n');
  const architectureOverview = archNotes || `No architecture narrative was produced. ${scan.stats.itemsScanned} item(s) were scanned; see the findings for structural observations.`;

  const ownLines = scan.ownership.slice(0, 20).map((o) => `- ${o.kind}: ${o.value} (${o.source})`);
  const ownershipSummary = `OWNERSHIP NOTICE: ${notes.ownership?.join(' ') || 'No model-generated ownership summary available.'}${ownLines.length ? `\n\nIndicators found:\n${ownLines.join('\n')}` : '\n\nNo ownership indicators were detected.'}`;

  return { executiveSummary, architectureOverview, technologySummary: technologySummary.trim() || 'No technology information available.', ownershipSummary, topRisks };
}
