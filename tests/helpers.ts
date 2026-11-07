/**
 * Shared test helpers: fixture paths and a temp-copy utility so tests can
 * add gitignored files (which cannot live in the committed fixture) without
 * touching the source tree.
 */

import { cp, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const SAMPLE_REPO = path.join(FIXTURES_DIR, 'sample-repo');

/** Copies the sample repo to a temp dir and adds files that must be ignored by the collector. */
export async function makeTempRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'auditor-fixture-'));
  await cp(SAMPLE_REPO, dir, { recursive: true });
  await mkdir(path.join(dir, 'secrets'), { recursive: true });
  await writeFile(path.join(dir, 'secrets', 'ignored.txt'), 'must not be collected\n');
  await writeFile(path.join(dir, 'debug.log'), 'must not be collected\n');
  await mkdir(path.join(dir, 'node_modules', 'leftpad'), { recursive: true });
  await writeFile(path.join(dir, 'node_modules', 'leftpad', 'index.js'), 'module.exports = 1;\n');
  await writeFile(path.join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Creates an empty temp directory. */
export async function makeTempDir(prefix = 'auditor-test-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
