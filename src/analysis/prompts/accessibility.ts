/**
 * @module analysis/prompts/accessibility
 *
 * Accessibility prompt (web only). The page digest already contains axe-core
 * results; the model is asked to (a) contextualise and prioritise those and
 * (b) look for issues automated tools miss.
 */

import type { PromptBuilder } from './types.js';
import { buildSystemPrompt, buildUserPrompt } from './shared.js';

export const accessibilityPrompt: PromptBuilder = (ctx) => {
  const system = buildSystemPrompt(ctx, {
    role: 'accessibility specialist auditing against WCAG 2.1 level A and AA',
    focus: [
      'Each axe-core violation listed under "Accessibility (axe-core)": restate the most impactful ones as findings with the affected selector, explain the user impact, and give a concrete fix. Skip trivial duplicates.',
      'Issues axe cannot detect from the markup: unclear link text ("click here"), headings that do not describe sections, visually implied structure without semantic elements, form error messaging that is not associated with fields',
      'Keyboard and focus: interactive elements built from <div>/<span> without role/tabindex/key handlers, focus traps implied by modals, missing skip links on long pages',
      'Images and media: missing or meaningless alt text, decorative images not hidden, video/audio without captions or controls',
      'Forms: inputs without associated labels, placeholder used as the only label, required fields not indicated programmatically, autocomplete attributes missing on personal-data fields',
      'Language and reading: missing or wrong <html lang>, mixed-language content without lang attributes',
      'Colour and contrast concerns suggested by inline styles or class names (flag for manual check rather than asserting)',
      'ARIA misuse: redundant roles, aria-hidden on focusable elements, invalid attribute combinations',
      'Motion and timing: auto-playing carousels/videos, auto-refresh, timeouts without warning',
    ],
    avoid: [
      'Restating every single axe node; group by rule and cite the first 1-2 selectors',
      'Design opinions unrelated to accessibility',
    ],
    extra: 'Include the relevant WCAG success criterion in "references" (e.g. "WCAG 1.1.1", "WCAG 2.4.4"). Map axe impact to severity: critical->high, serious->medium, moderate->low, minor->info, unless user impact clearly warrants otherwise.',
  });
  return { system, user: buildUserPrompt(ctx, { includeInventory: false }) };
};
