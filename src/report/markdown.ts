/**
 * @module report/markdown
 *
 * Renders an {@link AuditReport} as a self-contained Markdown document.
 * Sections, in order: header, executive summary, top risks, severity table,
 * ownership notice, technology summary, architecture overview, findings by
 * category, deterministic inventories, scan details, LLM usage, warnings.
 */

import type { AuditReport, Finding, Severity } from './types.js';
import { SEVERITIES } from './types.js';
import { CATEGORIES } from '../analysis/categories.js';

/** Renders the full Markdown report. */
export function renderMarkdown(report: AuditReport): string {
  const out: string[] = [];
  const kind = report.target.kind === 'code' ? 'Codebase' : 'Website';

  out.push(`# ${kind} audit report: ${report.target.resolved}`);
  out.push('');
  out.push(`Generated ${report.generatedAt} by ${report.tool.name} v${report.tool.version} in ${fmtDuration(report.durationMs)}.`);
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push(`| Target | \`${report.target.source}\`${report.target.cloned ? ' (cloned)' : ''} |`);
  if (report.target.remote) out.push(`| Git remote | ${report.target.remote}${report.target.branch ? ` (\`${report.target.branch}\`)` : ''} |`);
  out.push(`| Items analysed | ${report.scan.itemsScanned} (${report.scan.itemsSkipped} skipped), ~${report.scan.totalTokens.toLocaleString()} tokens |`);
  out.push(`| LLM | ${report.llm.dryRun ? '**DRY RUN (mock provider)**' : `${report.llm.primaryProvider} / ${report.llm.primaryModel}`}${report.llm.providersUsed.length > 1 ? ` (also used: ${report.llm.providersUsed.slice(1).join(', ')})` : ''} |`);
  out.push(`| Findings | ${report.findings.length} total: ${SEVERITIES.map((s) => `${report.severityCounts[s]} ${s}`).join(', ')} |`);
  out.push('');

  if (report.llm.dryRun) {
    out.push('> **Note:** this report was produced with the offline mock provider. Findings are placeholders that exercise the pipeline; run without `--dry-run` for real analysis.');
    out.push('');
  }

  out.push('## Executive summary');
  out.push('');
  out.push(report.narrative.executiveSummary);
  out.push('');

  if (report.narrative.topRisks.length) {
    out.push('### Top risks');
    out.push('');
    for (const r of report.narrative.topRisks) out.push(`1. ${r}`);
    out.push('');
  }

  out.push('### Findings by severity and category');
  out.push('');
  out.push(renderSeverityMatrix(report));
  out.push('');

  out.push('## Ownership notice');
  out.push('');
  out.push(report.narrative.ownershipSummary);
  out.push('');
  if (report.ownership.length) {
    out.push('<details><summary>All ownership indicators (' + report.ownership.length + ')</summary>');
    out.push('');
    out.push('| Kind | Value | Source | Context | Confidence |');
    out.push('|---|---|---|---|---|');
    for (const o of report.ownership) out.push(`| ${o.kind} | ${esc(o.value)} | ${esc(o.source)} | ${esc(o.context ?? '')} | ${o.confidence.toFixed(2)} |`);
    out.push('');
    out.push('</details>');
    out.push('');
  }
  if (report.gitAuthors?.length) {
    out.push('<details><summary>Git authors (' + report.gitAuthors.length + ')</summary>');
    out.push('');
    out.push('| Author | Commits | First | Last |');
    out.push('|---|---|---|---|');
    for (const a of report.gitAuthors.slice(0, 25)) out.push(`| ${esc(a.name)} <${esc(a.email)}> | ${a.commits} | ${a.firstCommit?.slice(0, 10) ?? ''} | ${a.lastCommit?.slice(0, 10) ?? ''} |`);
    out.push('');
    out.push('</details>');
    out.push('');
  }

  out.push('## Technology summary');
  out.push('');
  out.push(report.narrative.technologySummary);
  out.push('');
  if (report.technology.length) {
    out.push('<details><summary>Detected technologies (' + report.technology.length + ')</summary>');
    out.push('');
    out.push('| Technology | Version | Category | Evidence | Confidence |');
    out.push('|---|---|---|---|---|');
    for (const t of report.technology) out.push(`| ${esc(t.name)} | ${esc(t.version ?? '')} | ${t.category} | ${esc(t.evidence)} | ${t.confidence.toFixed(2)} |`);
    out.push('');
    out.push('</details>');
    out.push('');
  }

  out.push('## Architecture overview');
  out.push('');
  out.push(report.narrative.architectureOverview);
  out.push('');

  out.push('## Findings');
  out.push('');
  for (const def of CATEGORIES) {
    const result = report.categories.find((c) => c.category === def.id);
    if (!result) continue;
    const findings = report.findings.filter((f) => f.category === def.id);
    out.push(`### ${def.label} (${findings.length})`);
    out.push('');
    if (result.status === 'skipped') {
      out.push(`_Skipped: ${result.reason ?? 'not applicable'}._`);
      out.push('');
      continue;
    }
    if (result.status === 'failed') {
      out.push(`_All ${result.batchesFailed} batch(es) failed; see warnings._`);
      out.push('');
      continue;
    }
    if (result.status === 'partial') {
      out.push(`_${result.batchesFailed} of ${result.batchesRun + result.batchesFailed} batch(es) failed; results are partial._`);
      out.push('');
    }
    if (!findings.length) {
      out.push('_No findings._');
      out.push('');
      continue;
    }
    for (const f of findings) out.push(renderFinding(f));
  }

  out.push('## Scan details');
  out.push('');
  out.push(`- Duration: ${fmtDuration(report.scan.durationMs)}`);
  out.push(`- Items: ${report.scan.itemsScanned} analysed, ${report.scan.itemsSkipped} skipped, ${fmtBytes(report.scan.totalBytes)}`);
  const langs = Object.entries(report.scan.byLanguage).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (langs.length) out.push(`- Breakdown: ${langs.map(([k, v]) => `${k} (${v})`).join(', ')}`);
  for (const n of report.scan.notes) out.push(`- ${n}`);
  out.push('');

  out.push('## LLM usage');
  out.push('');
  out.push(`- Requests: ${report.usage.requests}`);
  out.push(`- Tokens: ${report.usage.inputTokens.toLocaleString()} in / ${report.usage.outputTokens.toLocaleString()} out${report.usage.partiallyEstimated ? ' (partially estimated)' : ''}`);
  for (const [k, v] of Object.entries(report.usage.byProvider)) out.push(`  - ${k}: ${v.requests} request(s), ${v.inputTokens.toLocaleString()} in / ${v.outputTokens.toLocaleString()} out`);
  if (report.llm.fallbacks.length) {
    out.push('- Provider fallbacks:');
    for (const e of report.llm.fallbacks) out.push(`  - ${e.at}: ${e.from} -> ${e.to ?? '(none)'} because ${e.reason}`);
  }
  out.push('');

  if (report.warnings.length) {
    out.push('## Warnings');
    out.push('');
    for (const w of report.warnings) out.push(`- ${w}`);
    out.push('');
  }

  out.push('---');
  out.push('_Findings are generated by a language model and must be verified by a human before action. Severity and confidence are the model\'s own assessment._');
  out.push('');
  return out.join('\n');
}

/** Renders one finding as a Markdown block. */
export function renderFinding(f: Finding): string {
  const loc = formatLocation(f);
  const lines: string[] = [];
  lines.push(`#### ${f.id} - ${esc(f.title)}`);
  lines.push('');
  lines.push(`**Severity:** ${f.severity} | **Confidence:** ${Math.round(f.confidence * 100)}%${loc ? ` | **Location:** ${loc}` : ''}`);
  lines.push('');
  lines.push(f.description);
  lines.push('');
  if (f.evidence) {
    lines.push('Evidence:');
    lines.push('');
    lines.push('```');
    lines.push(f.evidence.replace(/```/g, "'''"));
    lines.push('```');
    lines.push('');
  }
  if (f.recommendation) {
    lines.push(`**Recommendation:** ${f.recommendation}`);
    lines.push('');
  }
  const meta: string[] = [];
  if (f.references?.length) meta.push(`References: ${f.references.join(', ')}`);
  if (f.mergedFrom?.length) meta.push(`Merged: ${f.mergedFrom.join(', ')}`);
  meta.push(`Source: ${f.producedBy}`);
  lines.push(`<sub>${meta.join(' | ')}</sub>`);
  lines.push('');
  return lines.join('\n');
}

/** Formats a finding location as inline code. */
export function formatLocation(f: Finding): string {
  const { file, line, url, selector } = f.location;
  if (file) return `\`${file}${line ? `:${line}` : ''}\``;
  if (url) return `${url}${selector ? ` (\`${selector}\`)` : ''}`;
  return '';
}

function renderSeverityMatrix(report: AuditReport): string {
  const cats = CATEGORIES.filter((c) => report.categories.some((r) => r.category === c.id && r.status !== 'skipped'));
  const header = `| Category | ${SEVERITIES.join(' | ')} | Total |`;
  const sep = `|---|${SEVERITIES.map(() => '---:').join('|')}|---:|`;
  const rows = cats.map((c) => {
    const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    let total = 0;
    for (const f of report.findings) {
      if (f.category !== c.id) continue;
      counts[f.severity]++;
      total++;
    }
    return `| ${c.label} | ${SEVERITIES.map((s) => counts[s]).join(' | ')} | ${total} |`;
  });
  const totalRow = `| **Total** | ${SEVERITIES.map((s) => `**${report.severityCounts[s]}**`).join(' | ')} | **${report.findings.length}** |`;
  return [header, sep, ...rows, totalRow].join('\n');
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}
