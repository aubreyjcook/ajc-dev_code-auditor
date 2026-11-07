import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/report/markdown.js';
import { renderJson } from '../src/report/json.js';
import { renderTerminal } from '../src/report/terminal.js';
import { slugify, writeReports } from '../src/report/write.js';
import type { AuditReport } from '../src/report/types.js';
import { readFile } from 'node:fs/promises';
import { makeTempDir } from './helpers.js';

const report: AuditReport = {
  schemaVersion: 1,
  generatedAt: '2026-11-06T12:00:00.000Z',
  tool: { name: 'auditor', version: '0.1.0' },
  target: { kind: 'code', source: './repo', resolved: '/abs/repo', remote: 'https://github.com/x/y.git', branch: 'main' },
  llm: { primaryProvider: 'gemini', primaryModel: 'gemini-3.5-flash-lite', providersUsed: ['gemini/gemini-3.5-flash-lite', 'groq/openai/gpt-oss-120b'], fallbacks: [{ from: 'gemini/x', to: 'groq/y', reason: 'quota: exhausted', at: '2026-11-06T12:01:00.000Z' }], dryRun: false },
  scan: { itemsScanned: 3, itemsSkipped: 1, totalBytes: 1234, totalTokens: 400, byLanguage: { typescript: 3 }, durationMs: 50, notes: ['1 file(s) skipped: binary'] },
  categories: [
    { category: 'security', status: 'completed', findingCount: 1, batchesRun: 1, batchesFailed: 0, notes: [] },
    { category: 'quality', status: 'partial', findingCount: 0, batchesRun: 1, batchesFailed: 1, notes: [] },
    { category: 'accessibility', status: 'skipped', findingCount: 0, batchesRun: 0, batchesFailed: 0, notes: [], reason: 'not applicable to code targets' },
  ],
  narrative: {
    executiveSummary: 'Summary text.',
    architectureOverview: 'Arch text.',
    technologySummary: 'Tech text.',
    ownershipSummary: 'OWNERSHIP NOTICE: Acme Corp owns this.',
    topRisks: ['SEC-001: SQL injection'],
  },
  findings: [
    {
      id: 'SEC-001',
      category: 'security',
      severity: 'high',
      title: 'SQL injection | in query',
      description: 'Concatenated SQL.',
      location: { file: 'src/db.js', line: 7 },
      evidence: "runQuery('SELECT ' + id)",
      recommendation: 'Use parameters.',
      confidence: 0.9,
      references: ['CWE-89'],
      producedBy: 'gemini/gemini-3.5-flash-lite',
      mergedFrom: ['SEC-002'],
    },
  ],
  severityCounts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
  technology: [{ name: 'Express', category: 'framework', version: '^4', evidence: 'package.json', confidence: 0.9 }],
  ownership: [{ kind: 'copyright', value: '2024 Acme Corp', source: 'LICENSE', confidence: 0.95 }],
  gitAuthors: [{ name: 'Jane', email: 'j@acme.example', commits: 3, firstCommit: '2024-01-01T00:00:00Z', lastCommit: '2024-02-01T00:00:00Z' }],
  usage: { requests: 2, inputTokens: 100, outputTokens: 20, partiallyEstimated: false, byProvider: { 'gemini/gemini-3.5-flash-lite': { requests: 1, inputTokens: 50, outputTokens: 10 }, 'groq/openai/gpt-oss-120b': { requests: 1, inputTokens: 50, outputTokens: 10 } } },
  warnings: ['quality batch 1/1 failed: boom'],
  durationMs: 1234,
};

describe('renderMarkdown', () => {
  const md = renderMarkdown(report);

  it('contains every major section', () => {
    for (const h of ['# Codebase audit report', '## Executive summary', '### Top risks', '## Ownership notice', '## Technology summary', '## Architecture overview', '## Findings', '## Scan details', '## LLM usage', '## Warnings']) {
      expect(md).toContain(h);
    }
  });

  it('renders findings with escaped pipes, evidence, references and merges', () => {
    expect(md).toContain('#### SEC-001 - SQL injection \\| in query');
    expect(md).toContain('`src/db.js:7`');
    expect(md).toContain("runQuery('SELECT ' + id)");
    expect(md).toContain('References: CWE-89');
    expect(md).toContain('Merged: SEC-002');
  });

  it('reports category status', () => {
    expect(md).toMatch(/Code quality \(0\)\n\n_1 of 2 batch\(es\) failed/);
    expect(md).toMatch(/Accessibility \(0\)\n\n_Skipped: not applicable to code targets/);
  });

  it('lists fallbacks and provider usage', () => {
    expect(md).toContain('gemini/x -> groq/y because quota: exhausted');
    expect(md).toContain('groq/openai/gpt-oss-120b: 1 request(s)');
  });

  it('shows the dry-run banner only in dry runs', () => {
    expect(md).not.toContain('DRY RUN');
    expect(renderMarkdown({ ...report, llm: { ...report.llm, dryRun: true } })).toContain('DRY RUN');
  });
});

describe('renderJson / renderTerminal', () => {
  it('round-trips JSON', () => {
    expect(JSON.parse(renderJson(report))).toEqual(report);
  });
  it('terminal summary mentions counts, top finding, ownership, outputs', () => {
    const out = renderTerminal(report, { outputs: ['/tmp/report.md'] });
    expect(out).toContain('1 high');
    expect(out).toContain('SEC-001');
    expect(out).toContain('Acme Corp owns this');
    expect(out).toContain('/tmp/report.md');
    expect(out).toContain('Fallback: gemini/x -> groq/y');
  });
});

describe('writeReports', () => {
  it('writes both formats into a timestamped folder', async () => {
    const tmp = await makeTempDir();
    try {
      const res = await writeReports({ report, output: { dir: 'out', formats: ['markdown', 'json'] }, cwd: tmp.dir });
      expect(res.files).toHaveLength(2);
      expect(res.dir).toMatch(/2026-11-06T12-00-00-repo$/);
      const json = JSON.parse(await readFile(res.files[1]!, 'utf8'));
      expect(json.schemaVersion).toBe(1);
    } finally {
      await tmp.cleanup();
    }
  });

  it('slugifies paths and URLs sensibly', () => {
    expect(slugify('.')).toBe('target');
    expect(slugify('C:\\Users\\me\\my-repo')).toBe('my-repo');
    expect(slugify('/home/me/proj/')).toBe('proj');
    expect(slugify('https://github.com/acme/widget.git')).toBe('acme-widget');
    expect(slugify('git@github.com:acme/widget.git')).toBe('acme-widget');
    expect(slugify('https://www.example.com/docs/api?x=1')).toBe('www.example.com-docs-api');
  });
});
