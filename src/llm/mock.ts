/**
 * @module llm/mock
 *
 * Deterministic offline provider. Used by the test-suite and by `--dry-run`
 * so the whole pipeline (scan, chunk, prompt, parse, report) can be exercised
 * without network access or API keys.
 *
 * The mock inspects the request metadata and the `### File:` / `### Page:`
 * headers that the analyzer places in the user prompt, and fabricates
 * plausible findings that reference real locations from the batch. Output is
 * valid JSON in exactly the shape the analyzer expects, so parsing paths are
 * tested for real.
 */

import type { LlmProvider, LlmRequest, LlmResponse } from './provider.js';

/** Options for {@link MockProvider}. */
export interface MockProviderOptions {
  /** Simulated latency per request. */
  latencyMs?: number;
  /** Custom responder; when supplied it fully replaces the built-in behaviour. */
  responder?: (req: LlmRequest) => string | Promise<string>;
  /** When set, every call throws this error (used to test fallback). */
  failWith?: Error;
}

/** Offline provider producing canned, schema-valid JSON. */
export class MockProvider implements LlmProvider {
  readonly id = 'mock' as const;
  readonly label = 'Mock (offline)';
  readonly model = 'mock-1';
  /** Every request received, for assertions in tests. */
  readonly calls: LlmRequest[] = [];

  constructor(private readonly opts: MockProviderOptions = {}) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    if (this.opts.failWith) throw this.opts.failWith;
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));

    const text = this.opts.responder ? await this.opts.responder(req) : this.defaultResponse(req);
    return {
      text,
      usage: { inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(text.length / 4), estimated: true },
      provider: this.id,
      model: this.model,
      latencyMs: this.opts.latencyMs ?? 0,
    };
  }

  async ping(): Promise<void> {
    if (this.opts.failWith) throw this.opts.failWith;
  }

  private defaultResponse(req: LlmRequest): string {
    const kind = req.meta?.kind ?? 'analysis';
    if (kind === 'synthesis') return JSON.stringify(mockSynthesis(req), null, 2);
    if (kind === 'ping') return 'pong';
    return JSON.stringify(mockFindings(req), null, 2);
  }
}

/** Pulls `### File: x` / `### Page: y` locations out of a prompt. */
function extractLocations(user: string): { file?: string; url?: string }[] {
  const out: { file?: string; url?: string }[] = [];
  for (const m of user.matchAll(/^### (File|Page): (.+)$/gm)) {
    const value = m[2]!.trim();
    out.push(m[1] === 'File' ? { file: value } : { url: value });
  }
  return out;
}

function mockFindings(req: LlmRequest): unknown {
  const category = req.meta?.category ?? 'quality';
  const locations = extractLocations(req.user);
  const first = locations[0] ?? {};
  const second = locations[1] ?? first;

  const byCategory: Record<string, { title: string; severity: string; description: string; recommendation: string }> = {
    security: {
      title: 'Potential injection via unvalidated input',
      severity: 'high',
      description: 'Input reaches a sink without validation or encoding. (mock finding)',
      recommendation: 'Validate and encode input at the boundary; use parameterised APIs.',
    },
    quality: {
      title: 'Long function with mixed responsibilities',
      severity: 'medium',
      description: 'A function handles parsing, validation, and I/O together, making it hard to test. (mock finding)',
      recommendation: 'Split into smaller pure functions and isolate side effects.',
    },
    performance: {
      title: 'Synchronous work on the hot path',
      severity: 'low',
      description: 'Blocking operation executes inside a frequently-called routine. (mock finding)',
      recommendation: 'Move the work off the hot path or cache its result.',
    },
    accessibility: {
      title: 'Interactive element lacks an accessible name',
      severity: 'medium',
      description: 'A control has no label, so screen readers announce it generically. (mock finding)',
      recommendation: 'Add a visible label or aria-label.',
    },
    architecture: {
      title: 'Cross-layer dependency',
      severity: 'info',
      description: 'A presentation module imports directly from persistence. (mock finding)',
      recommendation: 'Introduce a service boundary between layers.',
    },
    technology: {
      title: 'Technology inventory observation',
      severity: 'info',
      description: 'Detected a framework version that is approaching end of life. (mock finding)',
      recommendation: 'Plan an upgrade.',
    },
    ownership: {
      title: 'Ownership indicator found',
      severity: 'info',
      description: 'A copyright or author attribution was located in the material. (mock finding)',
      recommendation: 'Confirm the attribution matches the expected owner.',
    },
    custom: {
      title: 'Custom rule violation',
      severity: 'medium',
      description: 'Material does not comply with a user-supplied rule. (mock finding)',
      recommendation: 'Align with the custom rule.',
    },
  };
  const tpl = byCategory[category] ?? byCategory.quality!;

  return {
    findings: [
      {
        title: tpl.title,
        severity: tpl.severity,
        description: tpl.description,
        location: { ...first, line: first.file ? 1 : undefined },
        evidence: 'mock evidence snippet',
        recommendation: tpl.recommendation,
        confidence: 0.6,
      },
      {
        title: `${tpl.title} (secondary)`,
        severity: 'low',
        description: `Second ${category} observation for coverage. (mock finding)`,
        location: { ...second },
        evidence: 'mock evidence snippet 2',
        recommendation: tpl.recommendation,
        confidence: 0.4,
      },
    ],
    notes: `Mock ${category} analysis of ${locations.length} item(s).`,
  };
}

function mockSynthesis(_req: LlmRequest): unknown {
  return {
    executiveSummary:
      'This is a mock synthesis produced by the offline provider. The pipeline ran end to end; swap in a real provider to obtain genuine analysis.',
    architectureOverview: 'Mock architecture overview: the target appears to be organised into a handful of modules with conventional layering.',
    technologySummary: 'Mock technology summary derived from the deterministic inventory included in the prompt.',
    ownershipSummary: 'Mock ownership summary: see the deterministic ownership signals listed in the report.',
    topRisks: ['Mock risk one', 'Mock risk two'],
    duplicateGroups: [],
  };
}
