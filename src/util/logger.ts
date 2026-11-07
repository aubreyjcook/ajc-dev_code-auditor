/**
 * @module util/logger
 *
 * Minimal levelled logger writing to stderr so that stdout stays clean for
 * machine-readable output (e.g. `--json` piping in the future). Colours are
 * applied via `picocolors`, which auto-disables when stderr is not a TTY.
 */

import pc from 'picocolors';
import type { LogLevel } from '../config/schema.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

let currentLevel: LogLevel = 'info';

/** Sets the global log level. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Returns the global log level. */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel];
}

function write(prefix: string, args: unknown[]): void {
  const text = args
    .map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  process.stderr.write(`${prefix} ${text}\n`);
}

/** Levelled logger. Each method is a no-op below the configured level. */
export const log = {
  error: (...args: unknown[]) => enabled('error') && write(pc.red('error'), args),
  warn: (...args: unknown[]) => enabled('warn') && write(pc.yellow('warn '), args),
  info: (...args: unknown[]) => enabled('info') && write(pc.cyan('info '), args),
  debug: (...args: unknown[]) => enabled('debug') && write(pc.dim('debug'), args),
  /** Progress lines: shown at info level, dimmed. */
  step: (...args: unknown[]) => enabled('info') && write(pc.dim('  ->  '), args),
};

export type Logger = typeof log;
