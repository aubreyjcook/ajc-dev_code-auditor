/**
 * @module analysis/usage
 *
 * Accumulates token usage across every LLM call in a run.
 */

import type { LlmResponse } from '../llm/provider.js';
import type { UsageSummary } from '../report/types.js';

/** Mutable usage accumulator. */
export class UsageTracker {
  private requests = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private partiallyEstimated = false;
  private readonly byProvider = new Map<string, { requests: number; inputTokens: number; outputTokens: number }>();
  private readonly order: string[] = [];

  /** Records one response. */
  record(res: LlmResponse): void {
    this.requests++;
    this.inputTokens += res.usage.inputTokens;
    this.outputTokens += res.usage.outputTokens;
    if (res.usage.estimated) this.partiallyEstimated = true;
    const key = `${res.provider}/${res.model}`;
    const entry = this.byProvider.get(key) ?? { requests: 0, inputTokens: 0, outputTokens: 0 };
    entry.requests++;
    entry.inputTokens += res.usage.inputTokens;
    entry.outputTokens += res.usage.outputTokens;
    if (!this.byProvider.has(key)) this.order.push(key);
    this.byProvider.set(key, entry);
  }

  /** Providers that served at least one request, in order of first use. */
  get providersUsed(): string[] {
    return [...this.order];
  }

  /** Snapshot for the report. */
  summary(): UsageSummary {
    return {
      requests: this.requests,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      partiallyEstimated: this.partiallyEstimated,
      byProvider: Object.fromEntries(this.byProvider),
    };
  }
}
