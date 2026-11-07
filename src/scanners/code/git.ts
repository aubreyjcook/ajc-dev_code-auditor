/**
 * @module scanners/code/git
 *
 * Git helpers for the code scanner:
 *
 *  - Recognise git URLs and clone them (shallow) into a temporary directory.
 *  - Read the remote URL and branch of an existing checkout.
 *  - Aggregate commit history into per-author statistics, which is one of the
 *    strongest signals for the "ownership" category.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { GitAuthorStat } from '../types.js';
import { isDirectory } from '../../util/fs.js';
import { log } from '../../util/logger.js';

/** True when `source` looks like something `git clone` would accept rather than a local path. */
export function isGitUrl(source: string): boolean {
  if (/^(https?|ssh|git):\/\//i.test(source)) return true;
  if (/^git@[^:]+:.+/.test(source)) return true;
  return false;
}

/** Result of {@link cloneToTemp}. */
export interface CloneResult {
  dir: string;
  /** Removes the temporary clone. */
  cleanup: () => Promise<void>;
}

/**
 * Clones `url` into a fresh temporary directory. History is limited to the
 * most recent 200 commits, enough for author statistics without pulling a
 * decade of history.
 */
export async function cloneToTemp(url: string): Promise<CloneResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'code-auditor-'));
  log.info(`Cloning ${url} ...`);
  try {
    await simpleGit().clone(url, dir, ['--depth', '200', '--single-branch']);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`git clone failed for ${url}: ${(err as Error).message}`);
  }
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Repository metadata discoverable from a checkout. */
export interface RepoInfo {
  isRepo: boolean;
  remote?: string;
  branch?: string;
  authors: GitAuthorStat[];
  totalCommits: number;
}

/**
 * Reads remote, branch, and author statistics from the repository at `dir`.
 * Returns `isRepo: false` (and no error) when the directory is not a git
 * checkout or git is unavailable.
 */
export async function readRepoInfo(dir: string): Promise<RepoInfo> {
  const empty: RepoInfo = { isRepo: false, authors: [], totalCommits: 0 };
  if (!(await isDirectory(path.join(dir, '.git')))) return empty;

  const git = simpleGit(dir);
  try {
    if (!(await git.checkIsRepo())) return empty;
  } catch {
    return empty;
  }

  const info: RepoInfo = { isRepo: true, authors: [], totalCommits: 0 };

  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
    if (origin?.refs.fetch) info.remote = redactCredentials(origin.refs.fetch);
  } catch (err) {
    log.debug(`git remotes unavailable: ${(err as Error).message}`);
  }

  try {
    info.branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  } catch (err) {
    log.debug(`git branch unavailable: ${(err as Error).message}`);
  }

  try {
    const logResult = await git.log({ maxCount: 2000, format: { an: '%an', ae: '%ae', ad: '%aI' } });
    const byAuthor = new Map<string, GitAuthorStat>();
    for (const entry of logResult.all as unknown as { an: string; ae: string; ad: string }[]) {
      const key = entry.ae.toLowerCase() || entry.an.toLowerCase();
      const existing = byAuthor.get(key);
      if (existing) {
        existing.commits++;
        if (!existing.firstCommit || entry.ad < existing.firstCommit) existing.firstCommit = entry.ad;
        if (!existing.lastCommit || entry.ad > existing.lastCommit) existing.lastCommit = entry.ad;
      } else {
        byAuthor.set(key, { name: entry.an, email: entry.ae, commits: 1, firstCommit: entry.ad, lastCommit: entry.ad });
      }
    }
    info.authors = [...byAuthor.values()].sort((a, b) => b.commits - a.commits);
    info.totalCommits = logResult.total;
  } catch (err) {
    log.debug(`git log unavailable: ${(err as Error).message}`);
  }

  return info;
}

/** Strips embedded `user:token@` credentials from a remote URL. */
export function redactCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]+@/, '$1');
}
