/**
 * @module analysis/prompts/architecture
 *
 * Architecture prompt. Produces structural observations as findings; the
 * synthesis pass later turns the collected notes into the narrative
 * "Architecture overview" section.
 */

import type { PromptBuilder } from './types.js';
import { buildSystemPrompt, buildUserPrompt } from './shared.js';

export const architecturePrompt: PromptBuilder = (ctx) => {
  const codeFocus = [
    'Overall structure: identifiable layers/modules (presentation, domain, data, infrastructure), monolith vs services, entry points',
    'Dependency direction: lower layers importing from higher ones, circular dependencies, UI code reaching into persistence',
    'Coupling and cohesion: god modules, utilities that know about everything, feature logic spread across many unrelated files',
    'Boundaries: where external systems (DB, HTTP, queues, filesystem) are accessed and whether they are abstracted or scattered',
    'Configuration and environment handling: how secrets/config are loaded, hard-coded environment specifics',
    'Error and logging strategy consistency across modules',
    'Build, deployment and runtime shape implied by manifests, Dockerfiles, CI, infra-as-code',
    'Scalability or evolution risks: single points of failure, assumptions that break under multi-instance deployment, schema migrations handled ad hoc',
  ];
  const webFocus = [
    'Rendering model: server-rendered, static, SPA, or hybrid - inferred from markup, framework globals, and script layout',
    'Hosting and delivery: CDN, edge platform, origin server, as inferred from headers',
    'API surface: endpoints referenced from inline scripts or forms, authentication flows implied by cookies and forms',
    'Third-party dependency footprint: analytics, tag managers, embeds, payment, auth providers and the trust implications',
    'Site structure: navigation depth, URL design, consistency across crawled pages, canonicalisation',
    'Progressive enhancement / resilience: behaviour without JS implied by markup, noscript fallbacks, service worker presence',
    'Operational signals: error pages, maintenance indicators, versioned asset URLs (deploy practice), security.txt presence',
  ];
  const system = buildSystemPrompt(ctx, {
    role: 'principal software architect assessing structure, boundaries, and long-term maintainability',
    focus: ctx.targetKind === 'code' ? codeFocus : webFocus,
    avoid: ['Line-level bugs (quality category)', 'Vulnerabilities (security category)'],
    extra:
      'Use the "notes" field to describe the architecture you can infer from this batch in 3-8 sentences (components, how they connect, notable patterns). That text feeds the final architecture overview, so be factual and specific. Findings should be reserved for structural problems or risks; severity "info" is appropriate for neutral observations worth recording.',
  });
  return { system, user: buildUserPrompt(ctx) };
};
