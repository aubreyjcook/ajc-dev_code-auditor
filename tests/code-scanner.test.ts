import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { collectFiles, priorityScore, languageFor } from '../src/scanners/code/collect.js';
import { detectCodeTech } from '../src/scanners/code/inventory.js';
import { detectCodeOwnership, detectLicenseName, orgFromRemote, findCopyrights } from '../src/scanners/code/ownership.js';
import { isGitUrl, redactCredentials } from '../src/scanners/code/git.js';
import { scanCode } from '../src/scanners/code/index.js';
import { CodeConfigSchema } from '../src/config/schema.js';
import { makeTempRepo } from './helpers.js';
import { setLogLevel } from '../src/util/logger.js';

setLogLevel('silent');
const codeConfig = CodeConfigSchema.parse({});

let repo: Awaited<ReturnType<typeof makeTempRepo>>;
beforeAll(async () => {
  repo = await makeTempRepo();
});
afterAll(async () => {
  await repo.cleanup();
});

describe('collectFiles', () => {
  it('honours .gitignore, built-in ignores, and binary detection', async () => {
    const { items, skipped } = await collectFiles(repo.dir, codeConfig);
    const ids = items.map((i) => i.id);
    expect(ids).toContain('package.json');
    expect(ids).toContain('src/index.js');
    expect(ids).toContain('.github/workflows/ci.yml');
    expect(ids).toContain('Dockerfile');
    expect(ids).not.toContain('secrets/ignored.txt'); // fixture .gitignore
    expect(ids).not.toContain('debug.log'); // *.log in fixture .gitignore
    expect(ids.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(ids).not.toContain('image.png');
    expect(skipped.length).toBe(0); // png is excluded before reading, so not counted as skipped
  });

  it('applies maxFiles keeping high-priority files', async () => {
    const { items, skipped } = await collectFiles(repo.dir, { ...codeConfig, maxFiles: 3 });
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.id)).toContain('package.json');
    expect(skipped.some((s) => /maxFiles/.test(s.reason))).toBe(true);
  });

  it('applies maxFileBytes', async () => {
    const { items, skipped } = await collectFiles(repo.dir, { ...codeConfig, maxFileBytes: 200 });
    expect(items.map((i) => i.id)).not.toContain('src/index.js');
    expect(skipped.some((s) => s.path === 'src/index.js' && /larger/.test(s.reason))).toBe(true);
  });

  it('ranks manifests above tests and docs', () => {
    expect(priorityScore('package.json')).toBeGreaterThan(priorityScore('src/app.ts'));
    expect(priorityScore('src/app.ts')).toBeGreaterThan(priorityScore('tests/app.test.ts'));
    expect(priorityScore('src/index.ts')).toBeGreaterThan(priorityScore('src/deep/nested/dir/util.ts'));
  });

  it('maps languages', () => {
    expect(languageFor('a/b.ts')).toBe('typescript');
    expect(languageFor('Dockerfile')).toBe('dockerfile');
    expect(languageFor('x.unknownext')).toBe('unknownext');
  });
});

describe('detectCodeTech', () => {
  it('detects runtime, frameworks, infra and CI from the fixture', async () => {
    const { items } = await collectFiles(repo.dir, codeConfig);
    const tech = detectCodeTech(items);
    const names = tech.map((t) => t.name);
    expect(names).toContain('Node.js');
    expect(names).toContain('Express');
    expect(names).toContain('PostgreSQL (pg)');
    expect(names).toContain('jsonwebtoken (JWT)');
    expect(names).toContain('Docker');
    expect(names).toContain('GitHub Actions');
    expect(names).toContain('JavaScript');
    const node = tech.find((t) => t.name === 'Node.js')!;
    expect(node.version).toBe('>=18');
    const docker = tech.find((t) => t.name === 'Docker')!;
    expect(docker.evidence).toContain('node:20-alpine');
  });
});

describe('detectCodeOwnership', () => {
  it('extracts author, license, copyright, CODEOWNERS, repository and git signals', async () => {
    const { items } = await collectFiles(repo.dir, codeConfig);
    const own = detectCodeOwnership(items, {
      remote: 'https://github.com/acme/sample-service.git',
      authors: [{ name: 'Jane Doe', email: 'jane@acme.example', commits: 40 }, { name: 'Bob', email: 'bob@acme.example', commits: 10 }],
    });
    const by = (kind: string) => own.filter((o) => o.kind === kind).map((o) => o.value);
    expect(by('author').join(' | ')).toMatch(/Jane Doe/);
    expect(by('maintainer').join(' | ')).toMatch(/Ops Team/);
    expect(by('license')).toContain('MIT');
    expect(by('copyright').some((v) => /Acme Corporation/.test(v))).toBe(true);
    expect(by('copyright').some((v) => /2021-2024/.test(v))).toBe(true); // from src/index.js header
    expect(by('codeowners')).toContain('@acme/platform-team');
    expect(by('repository').some((v) => /acme\/sample-service/.test(v))).toBe(true);
    expect(by('organization')).toContain('acme');
    const git = own.filter((o) => o.kind === 'git-author');
    expect(git[0]!.value).toMatch(/Jane Doe/);
    expect(git[0]!.context).toMatch(/80%/);
    expect(by('security-contact')).toHaveLength(0);
  });

  it('ignores prose that merely mentions the word copyright', () => {
    expect(findCopyrights('We respect copyright and trademarks of others.', { requireYear: true })).toHaveLength(0);
    expect(findCopyrights('Copyright (c) 2020 Example Ltd')).toEqual([{ year: '2020', holder: 'Example Ltd' }]);
    expect(findCopyrights('© Example Ltd. All rights reserved.')).toEqual([{ year: undefined, holder: 'Example Ltd' }]);
  });

  it('ignores documentation that talks about copyright patterns rather than stating one', () => {
    const fake: import('../src/scanners/types.js').ScanItem = {
      id: 'src/analysis/prompts/ownership.ts',
      kind: 'file',
      language: 'typescript',
      bytes: 100,
      tokens: 40,
      content: `/**
 * Looks at @author tags, "Copyright <year> <holder>" lines, LICENSE holders.
 * Title findings e.g. "Copyright holder: Acme Corp (LICENSE, 2019-2024)".
 */
export const x = 1;
`,
    };
    const own = detectCodeOwnership([fake]);
    expect(own.filter((o) => o.kind === 'copyright' || o.kind === 'author')).toEqual([]);
  });

  it('recognises license texts and git hosts', () => {
    expect(detectLicenseName('MIT License\n\nCopyright (c) 2020 X')).toBe('MIT');
    expect(detectLicenseName('Apache License\nVersion 2.0, January 2004')).toBe('Apache-2.0');
    expect(detectLicenseName('GNU GENERAL PUBLIC LICENSE Version 3')).toBe('GPL-3.0');
    expect(orgFromRemote('git@github.com:acme/repo.git')).toBe('acme');
    expect(orgFromRemote('https://gitlab.com/group/repo')).toBe('group');
  });
});

describe('git helpers', () => {
  it('recognises git URLs and redacts credentials', () => {
    expect(isGitUrl('https://github.com/a/b.git')).toBe(true);
    expect(isGitUrl('git@github.com:a/b.git')).toBe(true);
    expect(isGitUrl('./local')).toBe(false);
    expect(isGitUrl('C:\\repo')).toBe(false);
    expect(redactCredentials('https://user:tok@github.com/a/b.git')).toBe('https://github.com/a/b.git');
  });
});

describe('scanCode', () => {
  it('produces a full ScanResult for a local directory', async () => {
    const result = await scanCode({ source: repo.dir, config: codeConfig });
    expect(result.target.kind).toBe('code');
    expect(result.target.resolved).toBe(repo.dir);
    expect(result.items.length).toBeGreaterThan(5);
    expect(result.stats.itemsScanned).toBe(result.items.length);
    expect(result.tech.length).toBeGreaterThan(3);
    expect(result.ownership.length).toBeGreaterThan(3);
    expect(result.notes.some((n) => /Not a git repository/.test(n))).toBe(true);
  });

  it('rejects a non-directory', async () => {
    await expect(scanCode({ source: '/definitely/not/here', config: codeConfig })).rejects.toThrow(/Not a directory/);
  });
});
