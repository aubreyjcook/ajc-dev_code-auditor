/**
 * @module llm/fallback
 *
 * Wraps an ordered list of providers so that when the active one fails in a
 * way that is unlikely to recover (bad key, exhausted quota, repeated rate
 * limiting, unreachable host) the run continues on the next provider instead
 * of aborting. Each provider is wrapped with its own retry and rate limiter.
 *
 * Once a provider is abandoned it stays abandoned for the rest of the run;
 * flapping back and forth would just burn the remaining quota on both.
 */

import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './provider.js';
import { RateLimiter } from './throttle.js';
import { withRetry } from './retry.js';
import { log } from '../util/logger.js';

/** A provider plus the policy objects that govern calls to it. */
export interface ManagedProvider {
  provider: LlmProvider;
  limiter: RateLimiter;
  maxRetries: number;
}

/** Record of a provider switch, surfaced in the final report. */
export interface FallbackEvent {
  from: string;
  to: string | null;
  reason: string;
  at: string;
}

/**
 * Composite provider implementing retry, throttling, and fallback.
 *
 * The `id`, `model` and `label` getters reflect the *currently active*
 * provider so callers can report which backend served a request.
 */
export class FallbackProvider implements LlmProvider {
  private index = 0;
  readonly events: FallbackEvent[] = [];

  constructor(private readonly chain: ManagedProvider[]) {
    if (chain.length === 0) throw new Error('FallbackProvider requires at least one provider');
  }

  private get active(): ManagedProvider {
    return this.chain[this.index]!;
  }

  get id() {
    return this.active.provider.id;
  }
  get model() {
    return this.active.provider.model;
  }
  get label() {
    return this.active.provider.label;
  }

  /** Providers in the chain, for diagnostics. */
  get providers(): LlmProvider[] {
    return this.chain.map((m) => m.provider);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const current = this.active;
      try {
        return await withRetry(
          async () => {
            await current.limiter.acquire();
            return current.provider.complete(req);
          },
          { maxRetries: current.maxRetries, label: `${current.provider.label} ${req.meta?.label ?? ''}`.trim() },
        );
      } catch (err) {
        if (!(err instanceof LlmError) || !err.fallbackEligible || this.index >= this.chain.length - 1) {
          throw err;
        }
        const next = this.chain[this.index + 1]!;
        this.events.push({
          from: `${current.provider.id}/${current.provider.model}`,
          to: `${next.provider.id}/${next.provider.model}`,
          reason: `${err.kind}: ${err.message}`,
          at: new Date().toISOString(),
        });
        log.warn(`Switching provider ${current.provider.label} -> ${next.provider.label} (${err.kind}: ${err.message})`);
        this.index++;
      }
    }
  }

  async ping(): Promise<void> {
    return this.active.provider.ping();
  }
}
