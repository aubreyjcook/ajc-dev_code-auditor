/**
 * @module analysis/prompts/synthesis
 *
 * Final-pass prompt. Receives a compact view of every finding plus the
 * inventory and per-batch notes, and returns the narrative sections of the
 * report along with groups of duplicate findings to merge. Runs once per
 * audit, after all category batches.
 */

import type { Finding } from '../../report/types.js';
import type { GitAuthorStat, OwnershipSignal, ScanTarget, TechSignal } from '../../scanners/types.js';
import type { BuiltPrompt } from './types.js';

/** Input to {@link synthesisPrompt}. */
export interface SynthesisInput {
  target: ScanTarget;
  findings: Finding[];
  tech: TechSignal[];
  ownership: OwnershipSignal[];
  gitAuthors?: GitAuthorStat[];
  /** Per-category notes collected from batches. */
  categoryNotes: Record<string, string[]>;
  scanNotes: string[];
  stats: { items: number; tokens: number };
}

/** JSON contract for the synthesis response. */
export const SYNTHESIS_JSON_CONTRACT = `Respond with ONLY a JSON object (no prose, no Markdown fences):
{
  "executiveSummary": "4-8 sentences: what this is, overall health, the most important risks, and recommended next steps",
  "architectureOverview": "Markdown allowed. 1-3 paragraphs and/or bullets describing structure, components, data flow, deployment shape",
  "technologySummary": "Markdown allowed. Paragraph + bullets grouped by Languages / Frameworks / Data stores / Infrastructure / Build & CI / Third-party services, with versions when known",
  "ownershipSummary": "2-6 sentences naming the most likely owner(s)/author(s), the strongest evidence, confidence, and any conflicts. Start with 'OWNERSHIP NOTICE:'",
  "topRisks": ["up to 5 one-line risks, most severe first, each referencing finding ids like SEC-001"],
  "duplicateGroups": [["SEC-001", "SEC-007"], ["QUA-002", "QUA-009"]]
}
Rules:
- "duplicateGroups" lists findings that describe the SAME underlying issue at the SAME location (or the same pattern repeated with identical fix). Only group within the same category. Omit or leave empty if none.
- Do not invent findings; refer only to ids provided.
- Keep every string factual and grounded in the supplied material.`;

/** Builds the synthesis prompt. */
export function synthesisPrompt(input: SynthesisInput): BuiltPrompt {
  const system = [
    `You are the lead reviewer writing the final sections of an audit report for a ${input.target.kind === 'code' ? 'codebase' : 'live website'}. You have the complete list of findings produced by specialist reviewers, the deterministic inventory, and their free-text notes.`,
    '',
    'Your tasks: (1) write an executive summary a CTO could act on, (2) describe the architecture, (3) summarise the technology stack, (4) state who appears to own/author the material with evidence, (5) list the top risks, (6) identify duplicate findings to merge.',
    '',
    SYNTHESIS_JSON_CONTRACT,
  ].join('\n');

  const lines: string[] = [];
  lines.push(`# Target: ${input.target.resolved} (${input.target.kind})`);
  if (input.target.remote) lines.push(`Git remote: ${input.target.remote}${input.target.branch ? ` (branch ${input.target.branch})` : ''}`);
  lines.push(`Material analysed: ${input.stats.items} item(s), ~${input.stats.tokens.toLocaleString()} tokens`);
  if (input.scanNotes.length) lines.push('', '## Scan notes', ...input.scanNotes.map((n) => `- ${n}`));

  lines.push('', `## Findings (${input.findings.length})`);
  for (const f of input.findings) {
    const loc = f.location.file ? `${f.location.file}${f.location.line ? `:${f.location.line}` : ''}` : f.location.url ?? '';
    lines.push(`- ${f.id} [${f.severity}] (${f.category}) ${f.title} @ ${loc}${f.evidence ? ` | evidence: ${truncate(f.evidence, 120)}` : ''}`);
  }

  lines.push('', '## Detected technologies');
  for (const t of input.tech.slice(0, 100)) lines.push(`- ${t.name}${t.version ? ` ${t.version}` : ''} [${t.category}] - ${t.evidence}`);

  lines.push('', '## Ownership indicators');
  for (const o of input.ownership.slice(0, 80)) lines.push(`- ${o.kind}: ${o.value} (source: ${o.source}${o.context ? `; ${o.context}` : ''}; confidence ${o.confidence.toFixed(2)})`);
  if (input.gitAuthors?.length) {
    lines.push('', '## Git authors');
    for (const a of input.gitAuthors.slice(0, 10)) lines.push(`- ${a.name} <${a.email}>: ${a.commits} commit(s)${a.firstCommit ? `, ${a.firstCommit.slice(0, 10)} to ${a.lastCommit?.slice(0, 10)}` : ''}`);
  }

  for (const [category, notes] of Object.entries(input.categoryNotes)) {
    if (!notes.length) continue;
    lines.push('', `## Reviewer notes: ${category}`);
    for (const n of notes) lines.push(`- ${truncate(n, 1500)}`);
  }

  return { system, user: lines.join('\n') };
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 3)}...` : one;
}
