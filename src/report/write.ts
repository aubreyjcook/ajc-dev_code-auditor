/**
 * @module report/write
 *
 * Writes the selected report formats to a timestamped output directory.
 */

import path from 'node:path';
import type { OutputConfig } from '../config/schema.js';
import type { AuditReport } from './types.js';
import { renderMarkdown } from './markdown.js';
import { renderJson } from './json.js';
import { ensureDir, timestampSlug, writeText } from '../util/fs.js';

/** Options for {@link writeReports}. */
export interface WriteReportsOptions {
  report: AuditReport;
  output: OutputConfig;
  /** Base directory for relative `output.dir`. */
  cwd?: string;
  /** Override the run sub-folder name (default: timestamp + target slug). */
  runName?: string;
}

/** Result of {@link writeReports}. */
export interface WriteReportsResult {
  dir: string;
  files: string[];
}

/** Writes `report.md` and/or `report.json` and returns their paths. */
export async function writeReports(opts: WriteReportsOptions): Promise<WriteReportsResult> {
  const cwd = opts.cwd ?? process.cwd();
  // Local paths like "." are meaningless in a folder name; use the resolved directory instead.
  const slugSource = opts.report.target.kind === 'code' && !opts.report.target.cloned ? opts.report.target.resolved : opts.report.target.source;
  const runName = opts.runName ?? `${timestampSlug(new Date(opts.report.generatedAt))}-${slugify(slugSource)}`;
  const dir = path.resolve(cwd, opts.output.dir, runName);
  await ensureDir(dir);

  const files: string[] = [];
  if (opts.output.formats.includes('markdown')) {
    const p = path.join(dir, 'report.md');
    await writeText(p, renderMarkdown(opts.report));
    files.push(p);
  }
  if (opts.output.formats.includes('json')) {
    const p = path.join(dir, 'report.json');
    await writeText(p, renderJson(opts.report));
    files.push(p);
  }
  return { dir, files };
}

/**
 * Turns a path or URL into a short folder-safe slug.
 *
 * - URLs: `host` plus up to two path segments (`example.com-docs-api`).
 * - Git URLs: `owner-repo`.
 * - Local paths: the last directory name.
 */
export function slugify(source: string): string {
  let parts: string[];
  if (/^https?:\/\//i.test(source)) {
    try {
      const u = new URL(source);
      const segs = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
      parts = /\.git$/.test(u.pathname) || /github|gitlab|bitbucket/.test(u.host) ? segs.slice(-2) : [u.host, ...segs.slice(0, 2)];
    } catch {
      parts = [source];
    }
  } else if (/^git@/.test(source)) {
    parts = source.split(':').pop()!.replace(/\.git$/, '').split('/').filter(Boolean).slice(-2);
  } else {
    parts = source.replace(/[\\/]+$/, '').split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..');
    parts = parts.slice(-1);
  }
  const tail = parts.join('-');
  const cleaned = tail.replace(/[^a-z0-9._-]+/gi, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return cleaned || 'target';
}
