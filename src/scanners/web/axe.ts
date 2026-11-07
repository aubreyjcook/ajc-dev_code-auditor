/**
 * @module scanners/web/axe
 *
 * Runs axe-core inside a Playwright page and condenses the result. axe gives
 * deterministic, rule-based accessibility findings; the LLM then explains
 * them in context and looks for issues axe cannot detect (confusing copy,
 * poor focus order, unclear error messaging).
 */

import AxeBuilder from '@axe-core/playwright';
import type { Page } from 'playwright';
import type { AxePageSummary } from '../types.js';

/** Maximum nodes kept per violation to keep prompts compact. */
const MAX_NODES_PER_VIOLATION = 3;

/** Executes axe-core on `page` with the WCAG 2.1 A/AA rule set. */
export async function runAxe(page: Page): Promise<AxePageSummary> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  return {
    url: page.url(),
    violations: results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.slice(0, MAX_NODES_PER_VIOLATION).map((n) => ({
        target: Array.isArray(n.target) ? n.target.map(String).join(' ') : String(n.target),
        html: n.html.length > 200 ? `${n.html.slice(0, 200)}...` : n.html,
      })),
    })),
    passes: results.passes.length,
    incomplete: results.incomplete.length,
  };
}

/** Formats an axe summary as a short text block for inclusion in prompts. */
export function formatAxeSummary(axe: AxePageSummary): string {
  if (!axe.violations.length) return `axe-core: no violations (${axe.passes} rules passed, ${axe.incomplete} need review)`;
  const lines = [`axe-core: ${axe.violations.length} violation(s), ${axe.passes} passed, ${axe.incomplete} need review`];
  for (const v of axe.violations) {
    lines.push(`- [${v.impact ?? 'unknown'}] ${v.id}: ${v.help}`);
    for (const n of v.nodes) lines.push(`    at ${n.target}: ${n.html}`);
  }
  return lines.join('\n');
}
