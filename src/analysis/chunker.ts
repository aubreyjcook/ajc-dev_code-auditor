/**
 * @module analysis/chunker
 *
 * Groups scan items into batches that fit a token budget. Items are kept in
 * their natural order (path-sorted files, crawl-order pages) so related
 * material tends to land in the same batch, which helps the model reason
 * about cross-file issues. Items larger than the budget are truncated rather
 * than dropped.
 */

import type { ScanItem } from '../scanners/types.js';
import { estimateTokens, truncateToTokens } from '../llm/tokens.js';
import type { Batch } from './prompts/types.js';

/** Options for {@link chunkItems}. */
export interface ChunkOptions {
  /** Token budget for the material portion of one request. */
  tokenBudget: number;
  /**
   * Reserve for prompt overhead (system prompt, inventory, headings). The
   * effective material budget is `tokenBudget - overhead`.
   */
  overheadTokens?: number;
  /** Maximum items per batch regardless of size (keeps prompts readable). */
  maxItemsPerBatch?: number;
}

/** Splits items into token-budgeted batches. */
export function chunkItems(items: ScanItem[], opts: ChunkOptions): Batch[] {
  const overhead = opts.overheadTokens ?? 1500;
  const budget = Math.max(1000, opts.tokenBudget - overhead);
  const maxItems = opts.maxItemsPerBatch ?? 40;

  const batches: Batch[] = [];
  let current: ScanItem[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (!current.length) return;
    batches.push({ index: batches.length, items: current, tokens: currentTokens });
    current = [];
    currentTokens = 0;
  };

  for (const original of items) {
    // Line-number prefixes add roughly 6% on top of the raw estimate.
    let item = original;
    let tokens = Math.ceil(original.tokens * 1.06);

    if (tokens > budget) {
      const content = truncateToTokens(original.content, budget - 50);
      item = { ...original, content, tokens: estimateTokens(content), meta: { ...original.meta, truncated: true } };
      tokens = Math.ceil(item.tokens * 1.06);
    }

    if (current.length && (currentTokens + tokens > budget || current.length >= maxItems)) flush();
    current.push(item);
    currentTokens += tokens;
  }
  flush();
  return batches;
}

/**
 * Chooses a representative sample for categories that run once (technology).
 * Prefers manifests/config/entry points by the collector's priority score,
 * then fills with the first items in order, within one batch budget.
 */
export function sampleItems(items: ScanItem[], opts: ChunkOptions): Batch {
  const overhead = opts.overheadTokens ?? 1500;
  const budget = Math.max(1000, opts.tokenBudget - overhead);

  const ranked = [...items].sort((a, b) => {
    const pa = Number(a.meta?.priority ?? 0);
    const pb = Number(b.meta?.priority ?? 0);
    return pb - pa || a.id.localeCompare(b.id);
  });

  const chosen: ScanItem[] = [];
  let tokens = 0;
  for (const item of ranked) {
    // Cap any single item so a giant manifest cannot crowd out everything else.
    const cap = Math.floor(budget / 4);
    let candidate = item;
    if (item.tokens > cap) {
      const content = truncateToTokens(item.content, cap);
      candidate = { ...item, content, tokens: estimateTokens(content), meta: { ...item.meta, truncated: true } };
    }
    const t = Math.ceil(candidate.tokens * 1.06);
    if (tokens + t > budget) continue;
    chosen.push(candidate);
    tokens += t;
    if (chosen.length >= 25) break;
  }
  chosen.sort((a, b) => a.id.localeCompare(b.id));
  return { index: 0, items: chosen, tokens };
}
