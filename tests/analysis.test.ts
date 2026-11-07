import { describe, it, expect } from 'vitest';
import { chunkItems, sampleItems } from '../src/analysis/chunker.js';
import { parseAnalysisResponse, parseSynthesisResponse, toFinding } from '../src/analysis/schema.js';
import { dedupeHeuristically, assignIds, mergeGroups, deterministicNarrative } from '../src/analysis/synthesize.js';
import { resolveCategories, CATEGORIES } from '../src/analysis/categories.js';
import { analyze } from '../src/analysis/analyzer.js';
import { MockProvider } from '../src/llm/mock.js';
import { AnalysisConfigSchema } from '../src/config/schema.js';
import { withLineNumbers, renderMaterial } from '../src/analysis/prompts/shared.js';
import type { ScanItem, ScanResult } from '../src/scanners/types.js';
import type { Finding } from '../src/report/types.js';
import { setLogLevel } from '../src/util/logger.js';

setLogLevel('silent');

function item(id: string, chars: number, extra: Partial<ScanItem> = {}): ScanItem {
  const content = 'x'.repeat(chars);
  return { kind: 'file', id, content, tokens: Math.ceil(chars / 3.2), bytes: chars, language: 'text', ...extra };
}

describe('chunkItems', () => {
  it('packs items under the budget and preserves order', () => {
    const items = [item('a', 3000), item('b', 3000), item('c', 3000), item('d', 3000)];
    const batches = chunkItems(items, { tokenBudget: 4000, overheadTokens: 1000 }); // ~3000 material tokens per batch
    expect(batches.length).toBeGreaterThanOrEqual(2);
    const order = batches.flatMap((b) => b.items.map((i) => i.id));
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    for (const b of batches) expect(b.tokens).toBeLessThanOrEqual(3000);
  });

  it('truncates items larger than the budget instead of dropping them', () => {
    const items = [item('huge', 100_000)];
    const batches = chunkItems(items, { tokenBudget: 5000 });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.items[0]!.meta?.truncated).toBe(true);
    expect(batches[0]!.items[0]!.content).toContain('truncated by auditor');
  });

  it('respects maxItemsPerBatch', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`f${i}`, 10));
    const batches = chunkItems(items, { tokenBudget: 100_000, maxItemsPerBatch: 4 });
    expect(batches.map((b) => b.items.length)).toEqual([4, 4, 2]);
  });

  it('sampleItems prefers high-priority items', () => {
    const items = [item('z.ts', 100, { meta: { priority: 10 } }), item('package.json', 100, { meta: { priority: 100 } }), item('a.ts', 100, { meta: { priority: 50 } })];
    const sample = sampleItems(items, { tokenBudget: 1200, overheadTokens: 1000 }); // only ~200 tokens -> fits a few
    expect(sample.items.map((i) => i.id)).toContain('package.json');
  });
});

describe('prompt rendering', () => {
  it('numbers lines and emits File/Page headings', () => {
    expect(withLineNumbers('a\nb')).toBe('1| a\n2| b');
    const text = renderMaterial({
      targetKind: 'code',
      targetLabel: 't',
      batch: { index: 0, items: [item('src/a.ts', 5, { language: 'typescript' })], tokens: 5 },
      batchCount: 1,
      tech: [],
      ownership: [],
      scanNotes: [],
    });
    expect(text).toContain('### File: src/a.ts');
    expect(text).toContain('```typescript');
  });
});

describe('parseAnalysisResponse', () => {
  it('coerces sloppy model output', () => {
    const text = `Here you go:
\`\`\`json
{"findings":[
  {"title":"A","severity":"HIGH","description":"d","location":{"file":"x.ts","line":"12"},"recommendation":"r","confidence":80},
  {"title":"B","severity":"moderate","description":"d","location":"y.ts","recommendation":"r","confidence":"0.3"},
  {"title":"","severity":"low","description":"","recommendation":"r"},
  {"severity":"low"}
], "notes": "obs"}
\`\`\``;
    const parsed = parseAnalysisResponse(text);
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]).toMatchObject({ severity: 'high', confidence: 0.8, location: { file: 'x.ts', line: 12 } });
    expect(parsed.findings[1]).toMatchObject({ severity: 'medium', confidence: 0.3, location: { file: 'y.ts' } });
    expect(parsed.dropped).toBe(2);
    expect(parsed.notes).toEqual(['obs']);
  });

  it('accepts a bare array', () => {
    const parsed = parseAnalysisResponse('[{"title":"A","severity":"info","description":"d","recommendation":"r","confidence":0.5}]');
    expect(parsed.findings).toHaveLength(1);
  });

  it('parses synthesis with defaults for missing fields', () => {
    const s = parseSynthesisResponse('{"executiveSummary":"hi"}');
    expect(s.executiveSummary).toBe('hi');
    expect(s.duplicateGroups).toEqual([]);
    expect(s.topRisks).toEqual([]);
  });

  it('toFinding attributes single-item batches and normalises URLs in file', () => {
    const raw = parseAnalysisResponse('{"findings":[{"title":"A","severity":"low","description":"d","recommendation":"r","confidence":0.5}]}').findings[0]!;
    expect(toFinding(raw, 'quality', 'mock/mock-1', ['only.ts']).location.file).toBe('only.ts');
    expect(toFinding(raw, 'quality', 'mock/mock-1', ['https://x.test/']).location.url).toBe('https://x.test/');
    const raw2 = parseAnalysisResponse('{"findings":[{"title":"A","severity":"low","description":"d","location":{"file":"https://x.test/p"},"recommendation":"r","confidence":0.5}]}').findings[0]!;
    const f = toFinding(raw2, 'security', 'p/m', []);
    expect(f.location.url).toBe('https://x.test/p');
    expect(f.location.file).toBeUndefined();
  });
});

describe('dedupe / ids / merge', () => {
  const f = (over: Partial<Finding>): Finding => ({
    id: '',
    category: 'security',
    severity: 'medium',
    title: 'SQL injection in query',
    description: 'd',
    location: { file: 'a.ts', line: 1 },
    recommendation: 'r',
    confidence: 0.5,
    producedBy: 'mock/mock-1',
    ...over,
  });

  it('collapses identical findings keeping the most severe', () => {
    const out = dedupeHeuristically([f({ severity: 'low' }), f({ severity: 'high', confidence: 0.9 }), f({ title: 'SQL Injection in query!' })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('high');
  });

  it('assigns ids ordered by severity with category prefixes', () => {
    const out = assignIds([f({ severity: 'low', category: 'quality', title: 'q' }), f({ severity: 'critical' }), f({ severity: 'high', title: 'other' })]);
    expect(out.map((x) => x.id)).toEqual(['SEC-001', 'SEC-002', 'QUA-001']);
    expect(out[0]!.severity).toBe('critical');
  });

  it('merges groups proposed by synthesis within a category only', () => {
    const list = assignIds([f({ severity: 'high' }), f({ severity: 'low', title: 'dup', location: { file: 'b.ts' } }), f({ category: 'quality', severity: 'low', title: 'q' })]);
    const merged = mergeGroups(list, [
      ['SEC-001', 'SEC-002', 'QUA-001'],
      ['SEC-002', 'NOPE-9'],
    ]);
    expect(merged.map((x) => x.id)).toEqual(['SEC-001', 'QUA-001']);
    expect(merged[0]!.mergedFrom).toEqual(['SEC-002']);
  });
});

describe('categories', () => {
  it('resolves applicability and custom rules', () => {
    const all = CATEGORIES.map((c) => c.id);
    const code = resolveCategories(all, 'code', false);
    expect(code.run.map((c) => c.id)).not.toContain('accessibility');
    expect(code.run.map((c) => c.id)).not.toContain('custom');
    expect(code.skipped.find((s) => s.id === 'accessibility')!.reason).toMatch(/not applicable/);
    const web = resolveCategories(['security'], 'web', true);
    expect(web.run.map((c) => c.id)).toEqual(['security', 'custom']);
  });
});

describe('analyze with the mock provider', () => {
  const scan: ScanResult = {
    target: { kind: 'code', source: '.', resolved: '/repo' },
    items: [item('src/a.ts', 400, { language: 'typescript' }), item('src/b.ts', 400, { language: 'typescript' })],
    tech: [{ name: 'TypeScript', category: 'language', evidence: '2 files', confidence: 1 }],
    ownership: [],
    stats: { itemsScanned: 2, itemsSkipped: 0, totalBytes: 800, totalTokens: 250, byLanguage: { typescript: 2 }, durationMs: 1 },
    notes: [],
  };

  it('runs every applicable category and collects findings', async () => {
    const provider = new MockProvider();
    const config = AnalysisConfigSchema.parse({ categories: ['security', 'quality', 'technology', 'accessibility'] });
    const result = await analyze({ scan, provider, config });
    const byCat = Object.fromEntries(result.categories.map((c) => [c.category, c]));
    expect(byCat.security!.status).toBe('completed');
    expect(byCat.technology!.batchesRun).toBe(1);
    expect(byCat.accessibility!.status).toBe('skipped');
    expect(result.findings.length).toBe(6); // 2 per category x 3 categories, one batch
    expect(result.findings.every((f) => f.location.file)).toBe(true);
    expect(result.usage.summary().requests).toBe(3);
    expect(provider.calls.every((c) => c.jsonMode)).toBe(true);
  });

  it('records failures per batch instead of aborting', async () => {
    const provider = new MockProvider({ responder: () => 'this is not json at all' });
    const config = AnalysisConfigSchema.parse({ categories: ['security'] });
    const result = await analyze({ scan, provider, config });
    expect(result.categories.find((c) => c.category === 'security')!.status).toBe('failed');
    expect(result.warnings.some((w) => /failed/.test(w))).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('includes custom rules when provided', async () => {
    const provider = new MockProvider();
    const config = AnalysisConfigSchema.parse({ categories: [] });
    const result = await analyze({ scan, provider, config, customRules: 'R1: never use var' });
    expect(result.categories.map((c) => c.category)).toContain('custom');
    expect(provider.calls[0]!.system).toContain('R1: never use var');
  });

  it('deterministic narrative is produced without an LLM', () => {
    const n = deterministicNarrative(scan, [], {});
    expect(n.executiveSummary).toMatch(/0 finding/);
    expect(n.ownershipSummary).toMatch(/OWNERSHIP NOTICE/);
  });
});
