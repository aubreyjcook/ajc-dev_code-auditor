/**
 * @module analysis/prompts/shared
 *
 * Building blocks reused by every category prompt:
 *
 *  - the JSON output contract the analyzer parses,
 *  - rendering of the batch material (`### File:` / `### Page:` sections,
 *    which the mock provider and location-attribution logic also rely on),
 *  - rendering of the deterministic inventory (tech + ownership),
 *  - the common system-prompt frame.
 *
 * Prompt design notes:
 *  - We ask for *evidence* and *location* for every finding so the report is
 *    verifiable and so duplicates can be merged across batches.
 *  - We explicitly allow an empty `findings` array. Without that, models
 *    invent low-value issues to fill the list.
 *  - Severity definitions are spelled out to keep them consistent across
 *    categories and providers.
 */

import type { PromptContext } from './types.js';

/** The JSON contract. Kept as a string so it appears verbatim in prompts. */
export const FINDINGS_JSON_CONTRACT = `Respond with ONLY a JSON object (no prose, no Markdown fences) in this exact shape:
{
  "findings": [
    {
      "title": "short imperative summary (max 90 chars)",
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "description": "what is wrong and why it matters, 1-4 sentences",
      "location": { "file": "path/from/material", "line": 123, "url": "https://...", "selector": "css or element description" },
      "evidence": "short verbatim quote from the material (max 300 chars)",
      "recommendation": "concrete fix, 1-3 sentences",
      "confidence": 0.0-1.0,
      "references": ["CWE-79", "OWASP A03:2021", "WCAG 1.1.1"]
    }
  ],
  "notes": "optional free-text observations that are not findings"
}
Rules for the JSON:
- "location" must use "file" (and "line" if known) for code, or "url" (and "selector" if useful) for web pages. Use the exact path/URL shown in the "### File:" / "### Page:" headings.
- Omit keys you cannot fill rather than inventing values. "references" is optional.
- An empty "findings" array is a valid and often correct answer. Do not pad the list.
- Never include secrets or credentials verbatim in "evidence"; redact the sensitive part with "***".`;

/** Severity rubric shared by all categories. */
export const SEVERITY_RUBRIC = `Severity scale:
- critical: exploitable or data-destroying today with little effort; or blocks core use for many users.
- high: serious defect or exposure likely to cause real harm; fix soon.
- medium: meaningful risk or quality problem; schedule a fix.
- low: minor issue, hygiene, or defence-in-depth.
- info: observation, context, or positive note; no action strictly required.`;

/** Renders the batch material as Markdown sections with fenced code. */
export function renderMaterial(ctx: PromptContext): string {
  const parts: string[] = [];
  for (const item of ctx.batch.items) {
    if (item.kind === 'file') {
      parts.push(`### File: ${item.id}`);
      parts.push(`\`\`\`${item.language ?? ''}`);
      parts.push(withLineNumbers(item.content));
      parts.push('```');
    } else {
      parts.push(`### Page: ${item.id}`);
      parts.push(item.content);
    }
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * Prefixes each line with its 1-based number so the model can cite lines.
 * Files beyond ~4000 lines are left unnumbered to save tokens.
 */
export function withLineNumbers(text: string): string {
  const lines = text.split('\n');
  if (lines.length > 4000) return text;
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width, ' ')}| ${l}`).join('\n');
}

/** Renders the deterministic inventory block. */
export function renderInventory(ctx: PromptContext, opts: { tech?: boolean; ownership?: boolean; git?: boolean } = { tech: true, ownership: true, git: true }): string {
  const parts: string[] = [];
  if (opts.tech && ctx.tech.length) {
    parts.push('### Detected technologies (deterministic, from manifests/headers/markup)');
    for (const t of ctx.tech.slice(0, 80)) {
      parts.push(`- ${t.name}${t.version ? ` ${t.version}` : ''} [${t.category}] - ${t.evidence}`);
    }
  }
  if (opts.ownership && ctx.ownership.length) {
    parts.push('', '### Ownership indicators (deterministic)');
    for (const o of ctx.ownership.slice(0, 60)) {
      parts.push(`- ${o.kind}: ${o.value} (source: ${o.source}${o.context ? `; ${o.context}` : ''})`);
    }
  }
  if (opts.git && ctx.gitAuthors?.length) {
    parts.push('', '### Git authors (top by commits)');
    for (const a of ctx.gitAuthors.slice(0, 10)) parts.push(`- ${a.name} <${a.email}>: ${a.commits} commit(s)`);
  }
  if (ctx.scanNotes.length) {
    parts.push('', '### Scan notes');
    for (const n of ctx.scanNotes) parts.push(`- ${n}`);
  }
  return parts.join('\n');
}

/** Options for {@link buildSystemPrompt}. */
export interface SystemPromptParts {
  /** The persona, e.g. "senior application security engineer". */
  role: string;
  /** What to look for, as a bullet list. */
  focus: string[];
  /** What to ignore / not report. */
  avoid?: string[];
  /** Additional instructions appended before the JSON contract. */
  extra?: string;
}

/** Assembles the common system prompt frame. */
export function buildSystemPrompt(ctx: PromptContext, parts: SystemPromptParts): string {
  const targetDesc = ctx.targetKind === 'code' ? 'a codebase' : 'a live website / web application';
  return [
    `You are a ${parts.role} reviewing ${targetDesc}. You are given a batch of material (${ctx.batch.index + 1} of ${ctx.batchCount}) plus a deterministic inventory. Review only what is in front of you; do not assume code or pages you cannot see.`,
    '',
    'Focus on:',
    ...parts.focus.map((f) => `- ${f}`),
    ...(parts.avoid?.length ? ['', 'Do not report:', ...parts.avoid.map((a) => `- ${a}`)] : []),
    '',
    'Quality bar: every finding must cite a concrete location and quote evidence from the material. Prefer fewer, well-supported findings over many speculative ones. If the batch contains nothing noteworthy for this category, return an empty findings array.',
    '',
    SEVERITY_RUBRIC,
    ...(parts.extra ? ['', parts.extra] : []),
    '',
    FINDINGS_JSON_CONTRACT,
  ].join('\n');
}

/** Assembles the common user prompt: context header, inventory, material. */
export function buildUserPrompt(ctx: PromptContext, opts: { includeInventory?: boolean; preamble?: string } = {}): string {
  const parts: string[] = [];
  parts.push(`# Target: ${ctx.targetLabel} (${ctx.targetKind})`);
  if (opts.preamble) parts.push('', opts.preamble);
  if (opts.includeInventory !== false) {
    const inv = renderInventory(ctx);
    if (inv) parts.push('', '## Inventory', inv);
  }
  parts.push('', `## Material (batch ${ctx.batch.index + 1}/${ctx.batchCount}, ${ctx.batch.items.length} item(s))`, '', renderMaterial(ctx));
  return parts.join('\n');
}
