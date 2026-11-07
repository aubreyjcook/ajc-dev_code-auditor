/**
 * @module analysis/prompts/quality
 *
 * Code quality / correctness prompt. Emphasises real bugs and maintainability
 * hazards over style nitpicks, which linters already cover.
 */

import type { PromptBuilder } from './types.js';
import { buildSystemPrompt, buildUserPrompt } from './shared.js';

export const qualityPrompt: PromptBuilder = (ctx) => {
  const codeFocus = [
    'Likely bugs: off-by-one, null/undefined dereference, wrong operator, unhandled promise rejection, race conditions, incorrect async/await usage, mutation of shared state',
    'Error handling: swallowed exceptions, catch-all handlers that hide failures, missing cleanup (files, connections, timers), inconsistent error types',
    'Resource and lifecycle issues: leaks, unclosed handles, listeners never removed, unbounded caches or queues',
    'Maintainability: very long functions, deep nesting, duplicated logic, magic numbers, misleading names, dead or commented-out code',
    'Type safety: pervasive `any`, unchecked casts, ignoring compiler errors, missing validation at boundaries',
    'Test gaps: critical modules with no tests visible, tests that assert nothing, flaky patterns (sleeps, real network)',
    'Dependency hygiene: duplicate libraries for the same job, deprecated APIs, pinned ancient versions',
    'Documentation gaps that would block a new contributor (missing README sections, undocumented env vars)',
  ];
  const webFocus = [
    'Broken functionality visible in the crawl: console errors, failed requests, 4xx/5xx pages, broken internal links',
    'HTML correctness: duplicate ids, unclosed or misnested elements, missing doctype/lang/viewport/charset, invalid nesting of interactive elements',
    'Inline script quality: obvious bugs, global namespace pollution, deprecated APIs (document.write, synchronous XHR)',
    'Form robustness: missing validation attributes, unlabeled inputs, wrong input types for the data collected',
    'Inconsistent navigation structure, dead-end pages, redirect chains',
    'Error pages that expose internals or are unhelpful',
    'SEO/metadata hygiene that signals quality problems: missing titles/descriptions, duplicate titles across pages, noindex on primary pages',
  ];
  const system = buildSystemPrompt(ctx, {
    role: 'staff software engineer doing a rigorous code review focused on correctness and maintainability',
    focus: ctx.targetKind === 'code' ? codeFocus : webFocus,
    avoid: [
      'Pure formatting or lint-level style issues (quotes, semicolons, import order)',
      'Subjective preferences without a concrete downside',
      'Security or performance issues (separate categories cover them) unless they are also plain bugs',
    ],
  });
  return { system, user: buildUserPrompt(ctx) };
};
