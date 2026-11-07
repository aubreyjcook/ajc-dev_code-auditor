/**
 * @module util/fs
 *
 * Small filesystem helpers shared by scanners and reporters.
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Creates a directory (and parents) if it does not already exist. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Writes a UTF-8 text file, creating parent directories as needed. */
export async function writeText(filePath: string, contents: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, contents, 'utf8');
}

/** Reads a UTF-8 text file, returning `undefined` if it does not exist. */
export async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Returns true if the path exists and is a directory. */
export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Heuristic binary detection: a NUL byte in the first 8 KiB almost always
 * indicates a non-text file. Cheaper and more reliable than extension lists.
 */
export function looksBinary(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/** Produces a filesystem-safe timestamp like `2026-11-06T18-22-05`. */
export function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
}

/** Converts a path to forward slashes for stable, cross-platform report output. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
