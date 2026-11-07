/**
 * @module analysis/prompts/custom
 *
 * Custom rules prompt. The user's rules file is inserted verbatim; findings
 * must cite which rule was violated so they can be traced back.
 */

import type { PromptBuilder } from './types.js';
import { buildSystemPrompt, buildUserPrompt } from './shared.js';

export const customPrompt: PromptBuilder = (ctx) => {
  const rules = ctx.customRules?.trim() || '(no rules supplied)';
  const system = buildSystemPrompt(ctx, {
    role: 'reviewer enforcing a project-specific rule set supplied by the user',
    focus: [
      'Each rule in the RULES section below, applied strictly to the material',
      'Only violations of those rules; general best practice is covered by other categories',
    ],
    avoid: ['Inventing rules not present in the RULES section', 'Reporting compliance (only report violations, or return an empty list)'],
    extra: `Prefix each finding title with the rule identifier or a short quote of the rule, e.g. "[R3] ...". Put the rule text in "references".

RULES (verbatim from the user's file):
-----
${rules}
-----`,
  });
  return { system, user: buildUserPrompt(ctx, { includeInventory: false }) };
};
