/**
 * @module analysis/prompts/ownership
 *
 * Ownership / authorship prompt. The goal is to surface *who* is behind the
 * code or site: named people, organisations, copyright holders, contact
 * points, and any inconsistency between them (e.g. a repository whose
 * package.json names one company but whose LICENSE names another).
 *
 * This is reported as "special notifications" in the report: every signal
 * is listed with its source so the reader can verify it.
 */

import type { PromptBuilder } from './types.js';
import { buildSystemPrompt, buildUserPrompt } from './shared.js';

export const ownershipPrompt: PromptBuilder = (ctx) => {
  const system = buildSystemPrompt(ctx, {
    role: 'provenance analyst identifying the authors, owners, and responsible organisations behind the material',
    focus: [
      'Explicit attributions: author/maintainer fields, @author tags, "Copyright <year> <holder>" lines, LICENSE holders, CODEOWNERS, humans.txt, meta author, JSON-LD Organization/Person',
      'Organisational fingerprints: company names in namespaces/package scopes/class prefixes, internal domain names, email domains, internal URLs, cloud account identifiers (redact secrets), repository hosting organisation',
      'Contact points: support/security emails, security.txt contacts, legal/imprint pages, social profiles',
      'Branding in UI copy, titles, footers, error pages, default templates left unchanged (which indicate the original vendor rather than the operator)',
      'Inconsistencies: multiple conflicting copyright holders, license file naming a different owner than the manifest, forked-project remnants (upstream names in headers), template boilerplate attributions',
      'Signals of outsourcing or agency work: agency credits in footers/comments, generator tags, "built by" statements',
      'Git history evidence provided in the inventory: dominant committers and their email domains',
    ],
    avoid: [
      'Guessing identities not supported by evidence in the material; state uncertainty explicitly instead',
      'Reporting third-party library authors as owners of this project (e.g. a vendored library header) - mention them only to note they are third-party',
    ],
    extra:
      'Every finding in this category is informational unless an inconsistency or licensing conflict is found (use "medium" for conflicts). Title findings as the identity discovered, e.g. "Copyright holder: Acme Corp (LICENSE, 2019-2024)". In "notes", write 2-6 sentences summarising the most likely owner/author and your confidence, naming the strongest evidence; this feeds the report\'s "Ownership summary".',
  });
  return { system, user: buildUserPrompt(ctx) };
};
