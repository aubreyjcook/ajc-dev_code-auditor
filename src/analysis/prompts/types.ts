/**
 * @module analysis/prompts/types
 *
 * Types shared by all prompt builders.
 */

import type { GitAuthorStat, OwnershipSignal, ScanItem, TechSignal } from '../../scanners/types.js';

/** A group of items that fit in one request. */
export interface Batch {
  index: number;
  items: ScanItem[];
  tokens: number;
}

/** Everything a prompt builder may draw on. */
export interface PromptContext {
  targetKind: 'code' | 'web';
  /** Human label for the target (path or URL). */
  targetLabel: string;
  batch: Batch;
  batchCount: number;
  /** Deterministic inventory, included so the model does not guess. */
  tech: TechSignal[];
  ownership: OwnershipSignal[];
  gitAuthors?: GitAuthorStat[];
  /** Contents of the user's custom rules file, when supplied. */
  customRules?: string;
  /** Scan notes (what was skipped etc.). */
  scanNotes: string[];
}

/** System + user prompt pair. */
export interface BuiltPrompt {
  system: string;
  user: string;
}

/** Builds prompts for one category and one batch. */
export type PromptBuilder = (ctx: PromptContext) => BuiltPrompt;
