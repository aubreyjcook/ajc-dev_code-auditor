/**
 * @module analysis/prompts/technology
 *
 * Technology summary prompt. Runs once on a representative sample (not every
 * batch) because the deterministic inventory already carries most of the
 * facts; the model adds versions it can see, flags end-of-life or risky
 * choices, and notes anything the detectors missed.
 */

import type { PromptBuilder } from './types.js';
import { buildSystemPrompt, buildUserPrompt } from './shared.js';

export const technologyPrompt: PromptBuilder = (ctx) => {
  const system = buildSystemPrompt(ctx, {
    role: 'technology due-diligence analyst cataloguing the stack',
    focus: [
      'Confirm, correct, or extend the deterministic inventory: languages, frameworks, runtimes, databases, infrastructure, CI/CD, hosting, analytics, third-party services',
      'Versions: extract concrete versions visible in manifests, headers, or asset URLs; flag versions that are end-of-life, unsupported, or several majors behind',
      'Risky or unusual choices: abandoned libraries, duplicated frameworks, experimental features in production, heavy reliance on a single vendor',
      'Licensing red flags visible in manifests (copyleft dependencies in proprietary code, missing license fields)',
      'Technologies the detectors missed that are evident in the material',
    ],
    avoid: ['Repeating the inventory verbatim as findings; only emit findings for risks, EOL versions, or notable corrections'],
    extra:
      'In "notes", write a concise technology summary (one paragraph plus a bullet list grouped by: Languages, Frameworks, Data stores, Infrastructure/Hosting, Build/CI, Third-party services). This text becomes the report\'s "Technology summary" section, so be precise and include versions when known. Use severity "info" for neutral catalogue entries and "medium"/"high" for EOL or unsupported versions with known security exposure.',
  });
  return {
    system,
    user: buildUserPrompt(ctx, {
      preamble: 'The material below is a sample chosen to show manifests, configuration, and entry points. The inventory lists what deterministic detectors found.',
    }),
  };
};
