/**
 * @module analysis/categories
 *
 * Registry of analysis categories. Each entry declares which target kinds it
 * applies to and which prompt builder to use. The analyzer iterates over the
 * enabled, applicable categories for every batch of material.
 */

import type { CategoryId } from '../config/schema.js';
import type { PromptBuilder } from './prompts/types.js';
import { securityPrompt } from './prompts/security.js';
import { qualityPrompt } from './prompts/quality.js';
import { performancePrompt } from './prompts/performance.js';
import { accessibilityPrompt } from './prompts/accessibility.js';
import { architecturePrompt } from './prompts/architecture.js';
import { technologyPrompt } from './prompts/technology.js';
import { ownershipPrompt } from './prompts/ownership.js';
import { customPrompt } from './prompts/custom.js';

/** Static description of a category. */
export interface CategoryDefinition {
  id: CategoryId;
  /** Display label for reports. */
  label: string;
  /** Short description for `--help` and docs. */
  description: string;
  /** Target kinds this category applies to. */
  appliesTo: ('code' | 'web')[];
  /** Prefix used for finding ids, e.g. `SEC`. */
  idPrefix: string;
  /** Builds the system/user prompts for one batch. */
  prompt: PromptBuilder;
  /**
   * Whether the category needs the full material in every batch (`true`) or
   * is satisfied by a sample plus the deterministic inventory (`false`).
   * Inventory-style categories run once on a representative sample to save
   * free-tier quota.
   */
  perBatch: boolean;
}

/** All categories, in report order. */
export const CATEGORIES: readonly CategoryDefinition[] = [
  {
    id: 'security',
    label: 'Security',
    description: 'Injection, auth/session flaws, secrets, insecure configuration, missing headers (OWASP-aligned).',
    appliesTo: ['code', 'web'],
    idPrefix: 'SEC',
    prompt: securityPrompt,
    perBatch: true,
  },
  {
    id: 'quality',
    label: 'Code quality',
    description: 'Bugs, error handling, maintainability, dead code, test gaps.',
    appliesTo: ['code', 'web'],
    idPrefix: 'QUA',
    prompt: qualityPrompt,
    perBatch: true,
  },
  {
    id: 'performance',
    label: 'Performance',
    description: 'Hot-path inefficiencies, N+1 queries, blocking I/O, oversized payloads, caching gaps.',
    appliesTo: ['code', 'web'],
    idPrefix: 'PERF',
    prompt: performancePrompt,
    perBatch: true,
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    description: 'WCAG 2.1 A/AA issues, building on axe-core results (web targets only).',
    appliesTo: ['web'],
    idPrefix: 'A11Y',
    prompt: accessibilityPrompt,
    perBatch: true,
  },
  {
    id: 'architecture',
    label: 'Architecture',
    description: 'Structure, layering, coupling, dependency direction, deployment shape.',
    appliesTo: ['code', 'web'],
    idPrefix: 'ARCH',
    prompt: architecturePrompt,
    perBatch: true,
  },
  {
    id: 'technology',
    label: 'Technology',
    description: 'Languages, frameworks, services and versions in use, plus end-of-life or risky choices.',
    appliesTo: ['code', 'web'],
    idPrefix: 'TECH',
    prompt: technologyPrompt,
    perBatch: false,
  },
  {
    id: 'ownership',
    label: 'Ownership',
    description: 'Who authored or owns the code/site: attributions, copyrights, contacts, organisations.',
    appliesTo: ['code', 'web'],
    idPrefix: 'OWN',
    prompt: ownershipPrompt,
    perBatch: true,
  },
  {
    id: 'custom',
    label: 'Custom rules',
    description: 'User-supplied rules from --rules <file>.',
    appliesTo: ['code', 'web'],
    idPrefix: 'CUST',
    prompt: customPrompt,
    perBatch: true,
  },
];

/** Looks up a category definition. */
export function getCategory(id: CategoryId): CategoryDefinition {
  const def = CATEGORIES.find((c) => c.id === id);
  if (!def) throw new Error(`Unknown category: ${id}`);
  return def;
}

/**
 * Resolves the list of categories to run for a target, dropping those that
 * do not apply and adding `custom` when a rules file is supplied.
 */
export function resolveCategories(requested: CategoryId[], targetKind: 'code' | 'web', hasCustomRules: boolean): {
  run: CategoryDefinition[];
  skipped: { id: CategoryId; reason: string }[];
} {
  const run: CategoryDefinition[] = [];
  const skipped: { id: CategoryId; reason: string }[] = [];
  const wanted = new Set<CategoryId>(requested);
  if (hasCustomRules) wanted.add('custom');

  for (const def of CATEGORIES) {
    if (!wanted.has(def.id)) {
      skipped.push({ id: def.id, reason: 'not requested' });
      continue;
    }
    if (!def.appliesTo.includes(targetKind)) {
      skipped.push({ id: def.id, reason: `not applicable to ${targetKind} targets` });
      continue;
    }
    if (def.id === 'custom' && !hasCustomRules) {
      skipped.push({ id: def.id, reason: 'no --rules file supplied' });
      continue;
    }
    run.push(def);
  }
  return { run, skipped };
}
