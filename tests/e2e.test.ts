import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runAudit } from '../src/audit.js';
import { loadConfig } from '../src/config/load.js';
import { buildProgram } from '../src/cli.js';
import { makeTempRepo, makeTempDir } from './helpers.js';
import { setLogLevel } from '../src/util/logger.js';

setLogLevel('silent');

let repo: Awaited<ReturnType<typeof makeTempRepo>>;
let out: Awaited<ReturnType<typeof makeTempDir>>;
beforeAll(async () => {
  repo = await makeTempRepo();
  out = await makeTempDir();
});
afterAll(async () => {
  await repo.cleanup();
  await out.cleanup();
});

describe('end-to-end: audit code with the mock provider', () => {
  it('produces Markdown and JSON reports with the expected shape', async () => {
    const rulesPath = path.join(out.dir, 'rules.md');
    await writeFile(rulesPath, '# Rules\n\nR1. No string-concatenated SQL.\n');

    const config = loadConfig({
      env: {},
      skipDotenv: true,
      cwd: out.dir,
      cliOverrides: { dryRun: true, analysis: { customRulesFile: rulesPath, chunkTokenBudget: 4000 }, output: { dir: 'reports' }, logLevel: 'silent' },
    });
    const result = await runAudit({ kind: 'code', source: repo.dir, config, cwd: out.dir });

    expect(result.outputs).toHaveLength(2);
    for (const f of result.outputs) expect(existsSync(f)).toBe(true);

    const r = result.report;
    expect(r.schemaVersion).toBe(1);
    expect(r.llm.dryRun).toBe(true);
    expect(r.llm.providersUsed).toEqual(['mock/mock-1']);
    expect(r.target.kind).toBe('code');
    expect(r.scan.itemsScanned).toBeGreaterThan(5);

    const cats = Object.fromEntries(r.categories.map((c) => [c.category, c.status]));
    expect(cats.security).toBe('completed');
    expect(cats.custom).toBe('completed');
    expect(cats.accessibility).toBe('skipped');

    expect(r.findings.length).toBeGreaterThan(0);
    expect(new Set(r.findings.map((f) => f.id)).size).toBe(r.findings.length);
    expect(r.findings.every((f) => /^[A-Z0-9]+-\d{3}$/.test(f.id))).toBe(true);
    expect(r.findings.every((f) => f.location.file)).toBe(true);
    // ids are sorted by severity
    const order = ['critical', 'high', 'medium', 'low', 'info'];
    const ranks = r.findings.map((f) => order.indexOf(f.severity));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);

    expect(r.technology.map((t) => t.name)).toContain('Express');
    expect(r.ownership.some((o) => o.kind === 'copyright' && /Acme/.test(o.value))).toBe(true);
    expect(r.narrative.ownershipSummary.length).toBeGreaterThan(10);
    expect(r.usage.requests).toBeGreaterThan(1);

    const md = await readFile(result.outputs[0]!, 'utf8');
    expect(md).toContain('## Ownership notice');
    expect(md).toContain('Custom rules');
    const json = JSON.parse(await readFile(result.outputs[1]!, 'utf8'));
    expect(json.findings.length).toBe(r.findings.length);
  });

  it('noWrite returns the report without touching disk', async () => {
    const config = loadConfig({ env: {}, skipDotenv: true, cwd: out.dir, cliOverrides: { dryRun: true, analysis: { categories: ['technology'], synthesize: false }, logLevel: 'silent' } });
    const result = await runAudit({ kind: 'code', source: repo.dir, config, cwd: out.dir, noWrite: true });
    expect(result.outputs).toEqual([]);
    expect(result.report.categories.filter((c) => c.status === 'completed').map((c) => c.category)).toEqual(['technology']);
    expect(result.report.usage.requests).toBe(1); // one sampled request, no synthesis
  });
});

describe('CLI program', () => {
  it('exposes the expected commands and flags', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['code', 'web', 'providers', 'categories']));
    const code = program.commands.find((c) => c.name() === 'code')!;
    const flags = code.options.map((o) => o.long);
    for (const f of ['--provider', '--model', '--base-url', '--fallback', '--categories', '--rules', '--out', '--max-files', '--concurrency', '--dry-run', '--fail-on', '--verbose']) {
      expect(flags).toContain(f);
    }
    const web = program.commands.find((c) => c.name() === 'web')!;
    expect(web.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--max-pages', '--max-depth', '--timeout', '--no-axe', '--no-headless']));
  });
});
