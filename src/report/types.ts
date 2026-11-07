/**
 * @module report/types
 *
 * The report data model. `AuditReport` is what gets serialised to
 * `report.json`; the Markdown and terminal renderers are pure functions over
 * it, so any consumer of the JSON can regenerate the human-readable views.
 */

import type { CategoryId, ProviderId } from '../config/schema.js';
import type { GitAuthorStat, OwnershipSignal, ScanStats, ScanTarget, TechSignal } from '../scanners/types.js';
import type { FallbackEvent } from '../llm/fallback.js';

/** Severity scale shared by every category. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Where a finding was observed. */
export interface FindingLocation {
  /** Repository-relative path (code targets). */
  file?: string;
  /** 1-based line number, when the model could determine it. */
  line?: number;
  /** Page URL (web targets). */
  url?: string;
  /** CSS selector or element description (web targets). */
  selector?: string;
}

/** A single issue or observation. */
export interface Finding {
  /** Stable id like `SEC-001`, assigned after de-duplication. */
  id: string;
  category: CategoryId;
  severity: Severity;
  title: string;
  description: string;
  location: FindingLocation;
  /** Short quote of the offending code / markup, when available. */
  evidence?: string;
  recommendation: string;
  /** Model's self-reported confidence, 0..1. */
  confidence: number;
  /** Reference identifiers such as CWE-79, OWASP A03, WCAG 1.1.1. */
  references?: string[];
  /** Provider/model that produced this finding. */
  producedBy: string;
  /** Ids of findings merged into this one during synthesis. */
  mergedFrom?: string[];
}

/** Per-category outcome, including whether the model actually ran. */
export interface CategoryResult {
  category: CategoryId;
  /** `skipped` when not applicable (e.g. accessibility on a codebase) or disabled. */
  status: 'completed' | 'partial' | 'skipped' | 'failed';
  findingCount: number;
  batchesRun: number;
  batchesFailed: number;
  /** Free-text observations the model attached to batches (not findings). */
  notes: string[];
  reason?: string;
}

/** Token accounting for the whole run. */
export interface UsageSummary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** True when some numbers were estimated rather than provider-reported. */
  partiallyEstimated: boolean;
  /** Breakdown by `provider/model`. */
  byProvider: Record<string, { requests: number; inputTokens: number; outputTokens: number }>;
}

/** Narrative sections written by the synthesis pass. */
export interface Narrative {
  executiveSummary: string;
  architectureOverview: string;
  technologySummary: string;
  ownershipSummary: string;
  topRisks: string[];
}

/** Complete audit report. */
export interface AuditReport {
  /** Schema version for consumers of `report.json`. */
  schemaVersion: 1;
  generatedAt: string;
  tool: { name: string; version: string };
  target: ScanTarget;
  llm: {
    primaryProvider: ProviderId;
    primaryModel: string;
    /** Providers that actually served requests, in order of first use. */
    providersUsed: string[];
    fallbacks: FallbackEvent[];
    dryRun: boolean;
  };
  scan: ScanStats & { notes: string[] };
  categories: CategoryResult[];
  narrative: Narrative;
  findings: Finding[];
  /** Counts per severity across all findings. */
  severityCounts: Record<Severity, number>;
  technology: TechSignal[];
  ownership: OwnershipSignal[];
  gitAuthors?: GitAuthorStat[];
  usage: UsageSummary;
  /** Non-fatal problems encountered during the run. */
  warnings: string[];
  durationMs: number;
}

/** Severity ordering helper (lower index is more severe). */
export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}
