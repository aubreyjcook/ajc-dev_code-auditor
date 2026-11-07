import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, ConfigError, configFromEnv, deepMerge } from '../src/config/load.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { makeTempDir } from './helpers.js';

describe('config defaults', () => {
  it('defaults to the free Gemini provider with Flash-Lite', () => {
    const cfg = loadConfig({ env: {}, skipDotenv: true, cwd: '/nonexistent' });
    expect(cfg.llm.provider).toBe('gemini');
    expect(cfg.llm.model).toBeUndefined(); // resolved from the preset at provider construction
    expect(cfg.analysis.concurrency).toBe(1);
    expect(cfg.output.formats).toEqual(['markdown', 'json']);
    expect(DEFAULT_CONFIG.web.maxPages).toBe(10);
  });
});

describe('config precedence', () => {
  it('env < file < cli', async () => {
    const tmp = await makeTempDir();
    try {
      await writeFile(path.join(tmp.dir, 'auditor.config.json'), JSON.stringify({ llm: { provider: 'groq', model: 'from-file' }, web: { maxPages: 3 } }));
      const cfg = loadConfig({
        cwd: tmp.dir,
        skipDotenv: true,
        env: { AUDITOR_PROVIDER: 'mistral', AUDITOR_MODEL: 'from-env', AUDITOR_CONCURRENCY: '4' },
        cliOverrides: { llm: { model: 'from-cli' } },
      });
      expect(cfg.llm.provider).toBe('groq'); // file beats env
      expect(cfg.llm.model).toBe('from-cli'); // cli beats file
      expect(cfg.analysis.concurrency).toBe(4); // env survives when nothing overrides it
      expect(cfg.web.maxPages).toBe(3);
    } finally {
      await tmp.cleanup();
    }
  });

  it('undefined CLI values do not clobber lower layers', () => {
    const cfg = loadConfig({
      env: { AUDITOR_PROVIDER: 'groq' },
      skipDotenv: true,
      cwd: '/nonexistent',
      cliOverrides: { llm: { provider: undefined, model: undefined } },
    });
    expect(cfg.llm.provider).toBe('groq');
  });

  it('parses fallback provider lists from env', () => {
    const partial = configFromEnv({ AUDITOR_FALLBACK_PROVIDERS: 'groq, openrouter ollama' });
    expect(partial.llm?.fallbackProviders).toEqual(['groq', 'openrouter', 'ollama']);
  });

  it('accepts requestsPerMinute 0 from env to disable the limiter', () => {
    const cfg = loadConfig({
      env: { AUDITOR_REQUESTS_PER_MINUTE: '0' },
      skipDotenv: true,
      cwd: '/nonexistent',
    });
    expect(cfg.llm.requestsPerMinute).toBe(0);
  });

  it('dry-run forces the mock provider and drops fallbacks', () => {
    const cfg = loadConfig({ env: {}, skipDotenv: true, cwd: '/nonexistent', cliOverrides: { dryRun: true, llm: { provider: 'gemini', fallbackProviders: ['groq'] } } });
    expect(cfg.dryRun).toBe(true);
    expect(cfg.llm.provider).toBe('mock');
    expect(cfg.llm.fallbackProviders).toEqual([]);
  });
});

describe('config validation', () => {
  it('rejects unknown providers from env with a layer-specific error', () => {
    expect(() => loadConfig({ env: { AUDITOR_PROVIDER: 'nope' }, skipDotenv: true, cwd: '/nonexistent' })).toThrowError(ConfigError);
    try {
      loadConfig({ env: { AUDITOR_PROVIDER: 'nope' }, skipDotenv: true, cwd: '/nonexistent' });
    } catch (err) {
      expect((err as ConfigError).layer).toBe('env');
      expect((err as ConfigError).message).toMatch(/environment variables/);
    }
  });

  it('fails when an explicit config path is missing', () => {
    expect(() => loadConfig({ env: {}, skipDotenv: true, cwd: '/nonexistent', configPath: 'missing.json' })).toThrowError(/Config file not found/);
  });

  it('rejects malformed JSON config files', async () => {
    const tmp = await makeTempDir();
    try {
      await writeFile(path.join(tmp.dir, 'auditor.config.json'), '{ not json');
      expect(() => loadConfig({ cwd: tmp.dir, env: {}, skipDotenv: true })).toThrowError(/Could not parse/);
    } finally {
      await tmp.cleanup();
    }
  });
});

describe('deepMerge', () => {
  it('replaces arrays wholesale and merges objects', () => {
    const out = deepMerge({ a: { x: 1, y: [1, 2] }, b: 1 }, { a: { y: [3] }, c: 2 });
    expect(out).toEqual({ a: { x: 1, y: [3] }, b: 1, c: 2 });
  });
});
