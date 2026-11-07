/**
 * @module scanners/code
 *
 * Orchestrates a codebase scan: resolves the target (local path or git URL),
 * collects files, reads git metadata, and runs the deterministic technology
 * and ownership detectors. The output is a {@link ScanResult} ready for the
 * analysis layer.
 */

import path from 'node:path';
import type { CodeConfig } from '../../config/schema.js';
import type { ScanResult, ScanStats } from '../types.js';
import { collectFiles } from './collect.js';
import { cloneToTemp, isGitUrl, readRepoInfo } from './git.js';
import { detectCodeTech } from './inventory.js';
import { detectCodeOwnership } from './ownership.js';
import { isDirectory } from '../../util/fs.js';
import { log } from '../../util/logger.js';

export { collectFiles, BUILT_IN_IGNORES, languageFor, priorityScore } from './collect.js';
export { isGitUrl, cloneToTemp, readRepoInfo } from './git.js';
export { detectCodeTech } from './inventory.js';
export { detectCodeOwnership, detectLicenseName } from './ownership.js';

/** Options for {@link scanCode}. */
export interface ScanCodeOptions {
  /** Local directory or git URL. */
  source: string;
  config: CodeConfig;
  /** Base directory for resolving relative paths. */
  cwd?: string;
}

/**
 * Scans a codebase.
 *
 * Git URLs are cloned to a temporary directory that is removed once the scan
 * completes (the file contents are already in memory by then).
 */
export async function scanCode(opts: ScanCodeOptions): Promise<ScanResult> {
  const started = Date.now();
  const cwd = opts.cwd ?? process.cwd();
  const notes: string[] = [];

  let dir: string;
  let cleanup: (() => Promise<void>) | undefined;
  let cloned = false;

  if (isGitUrl(opts.source)) {
    const clone = await cloneToTemp(opts.source);
    dir = clone.dir;
    cleanup = clone.cleanup;
    cloned = true;
  } else {
    dir = path.resolve(cwd, opts.source);
    if (!(await isDirectory(dir))) {
      throw new Error(`Not a directory: ${dir}`);
    }
  }

  try {
    log.info(`Scanning ${dir}`);
    const [collected, repo] = await Promise.all([collectFiles(dir, opts.config), readRepoInfo(dir)]);

    if (collected.skipped.length) {
      const reasons = new Map<string, number>();
      for (const s of collected.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
      for (const [reason, n] of reasons) notes.push(`${n} file(s) skipped: ${reason}`);
    }
    if (repo.isRepo) {
      notes.push(`Git repository${repo.branch ? ` on branch ${repo.branch}` : ''}${repo.remote ? `, remote ${repo.remote}` : ''}, ${repo.totalCommits} commit(s) inspected`);
    } else {
      notes.push('Not a git repository (or git unavailable): author history not available');
    }

    const tech = detectCodeTech(collected.items);
    const ownership = detectCodeOwnership(collected.items, { remote: repo.remote, authors: repo.authors });

    const byLanguage: Record<string, number> = {};
    let totalBytes = 0;
    let totalTokens = 0;
    for (const item of collected.items) {
      byLanguage[item.language ?? 'unknown'] = (byLanguage[item.language ?? 'unknown'] ?? 0) + 1;
      totalBytes += item.bytes;
      totalTokens += item.tokens;
    }
    const stats: ScanStats = {
      itemsScanned: collected.items.length,
      itemsSkipped: collected.skipped.length,
      totalBytes,
      totalTokens,
      byLanguage,
      durationMs: Date.now() - started,
    };

    log.info(`Collected ${stats.itemsScanned} file(s), ~${stats.totalTokens.toLocaleString()} tokens; ${tech.length} tech signal(s), ${ownership.length} ownership signal(s)`);

    return {
      target: {
        kind: 'code',
        source: opts.source,
        resolved: dir,
        cloned,
        remote: repo.remote,
        branch: repo.branch,
      },
      items: collected.items,
      tech,
      ownership,
      gitAuthors: repo.authors,
      stats,
      notes,
    };
  } finally {
    if (cleanup) {
      try {
        await cleanup();
      } catch (err) {
        log.debug(`Temp clone cleanup failed: ${(err as Error).message}`);
      }
    }
  }
}
