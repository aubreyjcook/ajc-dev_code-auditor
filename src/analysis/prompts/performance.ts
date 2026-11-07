/**
 * @module analysis/prompts/performance
 *
 * Performance prompt. For code it targets algorithmic and I/O inefficiencies;
 * for web it targets page weight, blocking resources, and load behaviour
 * observable from the crawl.
 */

import type { PromptBuilder } from './types.js';
import { buildSystemPrompt, buildUserPrompt } from './shared.js';

export const performancePrompt: PromptBuilder = (ctx) => {
  const codeFocus = [
    'Database access: N+1 query patterns, queries inside loops, missing pagination, SELECT * on wide tables, missing indexes implied by lookups',
    'Blocking operations on hot paths: synchronous file/network I/O in request handlers, CPU-heavy work on the event loop, sleep/busy-wait',
    'Algorithmic complexity: nested loops over large collections, repeated linear searches where a map/set is appropriate, quadratic string building',
    'Memory: unbounded caches, loading whole files/datasets into memory, retaining large objects, leaking closures',
    'Concurrency: sequential awaits that could run in parallel, missing connection pooling, no backpressure on streams/queues',
    'Caching: recomputing expensive values, missing HTTP cache headers in server code, cache keys that never hit',
    'Front-end bundles: importing entire libraries for one function, heavy dependencies in client code, missing code splitting',
    'Startup and build: slow cold-start patterns, heavy top-level initialisation',
  ];
  const webFocus = [
    'Page weight: number and size of scripts/stylesheets, render-blocking resources in <head>, missing defer/async, many third-party hosts',
    'Load behaviour: slow load time reported for the page, long redirect chains, failed or retried requests',
    'Caching headers: missing/weak cache-control for static assets, no compression hints, no CDN evidence for heavy assets',
    'Images and media: missing width/height (layout shift), no lazy loading, oversized formats implied by markup',
    'Fonts: many web fonts, no font-display, fonts from multiple origins',
    'Third-party scripts: analytics/tag managers loaded synchronously, duplicated analytics vendors, chat widgets on every page',
    'DOM size and structure: extremely large DOM, deeply nested markup, inline styles at scale',
    'Mobile: missing viewport meta, fixed-width layouts implied by markup',
  ];
  const system = buildSystemPrompt(ctx, {
    role: 'performance engineer reviewing for latency, throughput, and resource efficiency',
    focus: ctx.targetKind === 'code' ? codeFocus : webFocus,
    avoid: [
      'Micro-optimisations with no measurable impact (e.g. for vs forEach)',
      'Speculation about infrastructure you cannot see',
    ],
    extra: 'Where possible, estimate impact qualitatively in the description (e.g. "scales with number of users", "adds a round trip per item").',
  });
  return { system, user: buildUserPrompt(ctx) };
};
