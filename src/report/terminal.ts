/**
 * @module report/terminal
 *
 * Compact coloured summary printed to stdout at the end of a run: severity
 * counts, the top findings, where the full reports were written, and token
 * usage. Designed to fit in one screen.
 */

import pc from 'picocolors';
import type { AuditReport, Severity } from './types.js';
import { SEVERITIES } from './types.js';
import { formatLocation } from './markdown.js';

const SEVERITY_COLOR: Record<Severity, (s: string) => string> = {
  critical: (s) => pc.bgRed(pc.white(s)),
  high: pc.red,
  medium: pc.yellow,
  low: pc.cyan,
  info: pc.dim,
};

/** Options for {@link renderTerminal}. */
export interface TerminalOptions {
  /** Paths of the files that were written. */
  outputs: string[];
  /** How many findings to list. */
  top?: number;
}

/** Renders the terminal summary as a string (caller prints it). */
export function renderTerminal(report: AuditReport, opts: TerminalOptions): string {
  const lines: string[] = [];
  const top = opts.top ?? 10;
  const kind = report.target.kind === 'code' ? 'Codebase' : 'Website';

  lines.push('');
  lines.push(pc.bold(`${kind} audit: ${report.target.resolved}`));
  if (report.llm.dryRun) lines.push(pc.yellow('DRY RUN - mock provider, findings are placeholders'));
  lines.push(
    pc.dim(
      `${report.scan.itemsScanned} item(s), ${report.usage.requests} LLM request(s) via ${report.llm.providersUsed.join(' -> ') || report.llm.primaryProvider}, ${fmtDuration(report.durationMs)}`,
    ),
  );
  lines.push('');

  lines.push(SEVERITIES.map((s) => SEVERITY_COLOR[s](` ${report.severityCounts[s]} ${s} `)).join(' '));
  lines.push('');

  const listed = report.findings.slice(0, top);
  if (listed.length) {
    lines.push(pc.bold(`Top ${listed.length} finding(s):`));
    for (const f of listed) {
      const loc = formatLocation(f).replace(/`/g, '');
      lines.push(`  ${SEVERITY_COLOR[f.severity](f.severity.padEnd(8))} ${pc.dim(f.id.padEnd(9))} ${f.title}${loc ? pc.dim(`  ${loc}`) : ''}`);
    }
    if (report.findings.length > listed.length) lines.push(pc.dim(`  ... and ${report.findings.length - listed.length} more in the report`));
    lines.push('');
  } else {
    lines.push(pc.green('No findings.'));
    lines.push('');
  }

  if (report.narrative.ownershipSummary) {
    const first = report.narrative.ownershipSummary.split('\n')[0]!;
    lines.push(pc.bold('Ownership: ') + first.replace(/^OWNERSHIP NOTICE:\s*/, '').slice(0, 300));
    lines.push('');
  }

  if (report.technology.length) {
    const names = [...new Set(report.technology.filter((t) => ['language', 'framework', 'cms', 'runtime'].includes(t.category)).map((t) => t.name))].slice(0, 10);
    if (names.length) {
      lines.push(pc.bold('Stack: ') + names.join(', '));
      lines.push('');
    }
  }

  lines.push(pc.bold('Reports:'));
  for (const o of opts.outputs) lines.push(`  ${o}`);
  lines.push('');

  lines.push(pc.dim(`Tokens: ${report.usage.inputTokens.toLocaleString()} in / ${report.usage.outputTokens.toLocaleString()} out${report.usage.partiallyEstimated ? ' (est.)' : ''}`));
  if (report.llm.fallbacks.length) {
    for (const e of report.llm.fallbacks) lines.push(pc.yellow(`Fallback: ${e.from} -> ${e.to} (${e.reason.split(':')[0]})`));
  }
  if (report.warnings.length) lines.push(pc.yellow(`${report.warnings.length} warning(s); see report for details`));
  lines.push('');
  return lines.join('\n');
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
