/**
 * @module analysis/schema
 *
 * Zod schemas for what the model is expected to return, plus a tolerant
 * parser. Models drift from the contract in small ways (severity in caps,
 * confidence as a percentage, `line` as a string), so we coerce where the
 * intent is unambiguous and drop only entries that are unusable.
 */

import { z } from 'zod';
import type { CategoryId } from '../config/schema.js';
import type { Finding, Severity } from '../report/types.js';
import { SEVERITIES } from '../report/types.js';
import { extractJson } from '../llm/json.js';

const SeveritySchema = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.toLowerCase().trim();
  if (s === 'informational' || s === 'information' || s === 'note') return 'info';
  if (s === 'moderate') return 'medium';
  if (s === 'severe' || s === 'serious') return 'high';
  if (s === 'blocker') return 'critical';
  return s;
}, z.enum(SEVERITIES));

const ConfidenceSchema = z.preprocess((v) => {
  if (typeof v === 'string') v = Number.parseFloat(v);
  if (typeof v === 'number' && v > 1 && v <= 100) return v / 100;
  return v;
}, z.number().min(0).max(1).catch(0.5));

const LineSchema = z.preprocess((v) => {
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return v;
}, z.number().int().positive().optional().catch(undefined));

const LocationSchema = z
  .object({
    file: z.string().optional(),
    line: LineSchema,
    url: z.string().optional(),
    selector: z.string().optional(),
  })
  .catch({});

/** One finding as returned by the model (before id assignment). */
export const RawFindingSchema = z.object({
  title: z.string().min(1).max(200),
  severity: SeveritySchema.catch('info'),
  description: z.string().min(1),
  location: z.preprocess((v) => (typeof v === 'string' ? { file: v } : (v ?? {})), LocationSchema),
  evidence: z.string().optional(),
  recommendation: z.string().catch(''),
  confidence: ConfidenceSchema,
  references: z.array(z.string()).optional().catch(undefined),
});

export type RawFinding = z.infer<typeof RawFindingSchema>;

/** Whole analysis response. */
export const AnalysisResponseSchema = z.object({
  findings: z.array(z.unknown()).catch([]),
  notes: z.union([z.string(), z.array(z.string())]).optional(),
});

/** Synthesis response. */
export const SynthesisResponseSchema = z.object({
  executiveSummary: z.string().catch(''),
  architectureOverview: z.string().catch(''),
  technologySummary: z.string().catch(''),
  ownershipSummary: z.string().catch(''),
  topRisks: z.array(z.string()).catch([]),
  duplicateGroups: z.array(z.array(z.string())).catch([]),
});

export type SynthesisResponse = z.infer<typeof SynthesisResponseSchema>;

/** Result of {@link parseAnalysisResponse}. */
export interface ParsedAnalysis {
  findings: RawFinding[];
  notes: string[];
  /** Number of entries dropped because they were unusable. */
  dropped: number;
}

/**
 * Parses model output into validated findings. Throws only when no JSON
 * can be extracted at all; malformed individual findings are dropped.
 */
export function parseAnalysisResponse(text: string): ParsedAnalysis {
  const json = extractJson<unknown>(text);
  // Some models return a bare array of findings.
  const container = Array.isArray(json) ? { findings: json } : json;
  const parsed = AnalysisResponseSchema.parse(container);

  const findings: RawFinding[] = [];
  let dropped = 0;
  for (const raw of parsed.findings) {
    const r = RawFindingSchema.safeParse(raw);
    if (r.success) findings.push(r.data);
    else dropped++;
  }
  const notes = parsed.notes === undefined ? [] : Array.isArray(parsed.notes) ? parsed.notes : [parsed.notes];
  return { findings, notes: notes.filter((n) => n && n.trim()), dropped };
}

/** Parses the synthesis response, tolerating missing fields. */
export function parseSynthesisResponse(text: string): SynthesisResponse {
  return SynthesisResponseSchema.parse(extractJson<unknown>(text));
}

/**
 * Converts a raw finding into a report finding. Ids are assigned later by
 * the de-duplication step, so a placeholder is used here.
 */
export function toFinding(raw: RawFinding, category: CategoryId, producedBy: string, batchItemIds: string[]): Finding {
  const location = { ...raw.location };
  // If the model omitted a location but the batch had a single item, attribute to it.
  if (!location.file && !location.url && batchItemIds.length === 1) {
    const only = batchItemIds[0]!;
    if (/^https?:\/\//.test(only)) location.url = only;
    else location.file = only;
  }
  // Models sometimes put a URL in `file` for web targets; normalise.
  if (location.file && /^https?:\/\//.test(location.file)) {
    location.url = location.url ?? location.file;
    delete location.file;
  }
  return {
    id: '',
    category,
    severity: raw.severity as Severity,
    title: raw.title.trim(),
    description: raw.description.trim(),
    location,
    evidence: raw.evidence?.trim() || undefined,
    recommendation: raw.recommendation.trim(),
    confidence: raw.confidence,
    references: raw.references?.filter(Boolean),
    producedBy,
  };
}
