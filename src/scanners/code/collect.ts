/**
 * @module scanners/code/collect
 *
 * Walks a directory tree and returns the text files worth sending to the
 * model. Honours `.gitignore` files (root and nested), a built-in ignore list
 * for generated/vendored content, a size ceiling, and a binary sniff. When
 * the result still exceeds `maxFiles`, files are ranked so that manifests,
 * configuration, and entry points survive before deep leaf modules.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import ignore, { type Ignore } from 'ignore';
import type { CodeConfig } from '../../config/schema.js';
import type { ScanItem } from '../types.js';
import { looksBinary, readTextIfExists, toPosix } from '../../util/fs.js';
import { estimateTokens } from '../../llm/tokens.js';
import { log } from '../../util/logger.js';

/**
 * Directories and file patterns that are never useful to audit: dependency
 * trees, build output, VCS internals, lockfiles, caches, media.
 */
export const BUILT_IN_IGNORES: string[] = [
  '.git/',
  '.hg/',
  '.svn/',
  'node_modules/',
  'bower_components/',
  'vendor/',
  'dist/',
  'build/',
  'out/',
  'target/',
  'bin/',
  'obj/',
  '.next/',
  '.nuxt/',
  '.output/',
  '.svelte-kit/',
  '.turbo/',
  '.cache/',
  '.parcel-cache/',
  'coverage/',
  '.nyc_output/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '.tox/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.idea/',
  '.vscode/',
  '.DS_Store',
  'Thumbs.db',
  'audit-output/',
  // Lockfiles are huge and carry no reviewable logic (manifests are kept).
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  // Minified / generated bundles.
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.bundle.js',
  '*.chunk.js',
  // Binary and media types.
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.webp',
  '*.ico',
  '*.svg',
  '*.bmp',
  '*.tiff',
  '*.pdf',
  '*.zip',
  '*.gz',
  '*.tar',
  '*.tgz',
  '*.7z',
  '*.rar',
  '*.jar',
  '*.war',
  '*.class',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.o',
  '*.a',
  '*.wasm',
  '*.mp3',
  '*.mp4',
  '*.mov',
  '*.avi',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  '*.otf',
  '*.pyc',
  '*.db',
  '*.sqlite',
  '*.sqlite3',
];

/** Maps file extensions to a language label used for histograms and prompts. */
export const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
  '.py': 'python',
  '.rb': 'ruby',
  '.php': 'php',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.cs': 'csharp',
  '.fs': 'fsharp',
  '.vb': 'vbnet',
  '.swift': 'swift',
  '.m': 'objective-c',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hs': 'haskell',
  '.lua': 'lua',
  '.pl': 'perl',
  '.r': 'r',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.ps1': 'powershell',
  '.sql': 'sql',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.txt': 'text',
  '.env': 'dotenv',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'config',
  '.tf': 'terraform',
  '.hcl': 'hcl',
  '.dockerfile': 'dockerfile',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'protobuf',
  '.prisma': 'prisma',
};

/** Dependency manifests: the single most informative files in a project. */
const MANIFEST_BASENAMES = new Set([
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'pipfile',
  'go.mod',
  'cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'gemfile',
  'composer.json',
  'mix.exs',
  'pubspec.yaml',
]);

/** Files whose basename alone marks them as important project metadata. */
const HIGH_PRIORITY_BASENAMES = new Set([
  ...MANIFEST_BASENAMES,
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'makefile',
  'readme.md',
  'readme',
  'license',
  'license.md',
  'license.txt',
  'codeowners',
  'security.md',
  'tsconfig.json',
  '.env.example',
  'serverless.yml',
  'vercel.json',
  'netlify.toml',
  'app.yaml',
  'main.tf',
]);

/** Options for {@link collectFiles}. */
export interface CollectOptions extends Pick<CodeConfig, 'maxFiles' | 'maxFileBytes' | 'include' | 'exclude'> {}

/** Result of {@link collectFiles}. */
export interface CollectResult {
  items: ScanItem[];
  skipped: { path: string; reason: string }[];
  /** Total candidate files before caps were applied. */
  candidates: number;
}

/**
 * Collects auditable files under `root`.
 *
 * @param root - Absolute directory path.
 * @param opts - Size and count limits plus extra include/exclude globs.
 */
export async function collectFiles(root: string, opts: CollectOptions): Promise<CollectResult> {
  const ig = await buildIgnore(root, opts.exclude);

  const all = await fg(opts.include.length ? opts.include : ['**/*'], {
    cwd: root,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    // Prune the heaviest directories at the glob level so we never descend into them.
    ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/vendor/**', '**/target/**'],
  });

  const kept = all.filter((rel) => !ig.ignores(rel)).sort();
  const skipped: { path: string; reason: string }[] = [];

  // Rank before reading so we do not read thousands of files only to drop them.
  const ranked = kept
    .map((rel) => ({ rel, score: priorityScore(rel) }))
    .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));

  const items: ScanItem[] = [];
  for (const { rel } of ranked) {
    if (items.length >= opts.maxFiles) {
      skipped.push({ path: rel, reason: `maxFiles (${opts.maxFiles}) reached` });
      continue;
    }
    const abs = path.join(root, rel);
    let size: number;
    try {
      size = (await stat(abs)).size;
    } catch {
      skipped.push({ path: rel, reason: 'unreadable' });
      continue;
    }
    if (size === 0) {
      skipped.push({ path: rel, reason: 'empty' });
      continue;
    }
    if (size > opts.maxFileBytes) {
      skipped.push({ path: rel, reason: `larger than ${opts.maxFileBytes} bytes` });
      continue;
    }
    const buf = await readFile(abs);
    if (looksBinary(buf)) {
      skipped.push({ path: rel, reason: 'binary' });
      continue;
    }
    const content = buf.toString('utf8');
    const posix = toPosix(rel);
    items.push({
      kind: 'file',
      id: posix,
      content,
      tokens: estimateTokens(content),
      bytes: size,
      language: languageFor(posix),
      meta: { priority: priorityScore(posix) },
    });
  }

  // Restore a stable, path-sorted order for presentation; priority only
  // mattered for the cap.
  items.sort((a, b) => a.id.localeCompare(b.id));

  log.debug(`collectFiles: ${all.length} found, ${kept.length} after ignores, ${items.length} kept, ${skipped.length} skipped`);
  return { items, skipped, candidates: kept.length };
}

/**
 * Builds the ignore matcher from built-ins, the root `.gitignore`, nested
 * `.gitignore` files (prefixed with their directory), and user excludes.
 */
async function buildIgnore(root: string, userExcludes: string[]): Promise<Ignore> {
  const ig = ignore();
  ig.add(BUILT_IN_IGNORES);
  ig.add(userExcludes);

  const gitignores = await fg(['**/.gitignore'], {
    cwd: root,
    dot: true,
    onlyFiles: true,
    suppressErrors: true,
    ignore: ['**/node_modules/**', '**/.git/**'],
  });

  for (const rel of gitignores) {
    const content = await readTextIfExists(path.join(root, rel));
    if (!content) continue;
    const dir = toPosix(path.dirname(rel));
    const prefix = dir === '.' ? '' : `${dir}/`;
    const patterns = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => scopePattern(l, prefix));
    ig.add(patterns);
  }
  return ig;
}

/**
 * Re-roots a nested .gitignore pattern so it only applies under its
 * directory, following gitignore semantics: patterns containing a slash are
 * anchored to that directory; others match at any depth beneath it.
 */
function scopePattern(pattern: string, prefix: string): string {
  if (!prefix) return pattern;
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  const anchoredOrNested = body.includes('/') && !body.endsWith('/');
  const scoped = body.startsWith('/')
    ? `${prefix}${body.slice(1)}`
    : anchoredOrNested
      ? `${prefix}${body}`
      : `${prefix}**/${body}`;
  return negated ? `!${scoped}` : scoped;
}

/** Language label for a path, based on extension or well-known basename. */
export function languageFor(relPath: string): string {
  const base = path.posix.basename(relPath).toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  if (base.startsWith('.env')) return 'dotenv';
  const ext = path.posix.extname(base);
  return LANGUAGE_BY_EXT[ext] ?? (ext ? ext.slice(1) : 'text');
}

/**
 * Heuristic importance score used only when the file cap is hit.
 * Higher is kept first: manifests > config/entry points > shallow source >
 * deep source > tests/docs/data.
 */
export function priorityScore(relPath: string): number {
  const posix = toPosix(relPath);
  const base = path.posix.basename(posix).toLowerCase();
  const depth = posix.split('/').length - 1;
  let score = 50 - Math.min(depth, 10) * 2;

  if (HIGH_PRIORITY_BASENAMES.has(base)) score += 60;
  if (MANIFEST_BASENAMES.has(base)) score += 10;
  if (/^(index|main|app|server|cli|routes?|handler|controller)\.[a-z]+$/.test(base)) score += 20;
  if (/^(\.github\/workflows|\.gitlab-ci|\.circleci|azure-pipelines)/.test(posix)) score += 15;
  if (/(^|\/)(src|app|lib|server|api|pkg|cmd|internal)\//.test(posix)) score += 10;
  if (/(^|\/)(test|tests|__tests__|spec|specs|e2e|fixtures?|mocks?)\//.test(posix) || /\.(test|spec)\.[a-z]+$/.test(base)) score -= 20;
  if (/(^|\/)(docs?|examples?|samples?)\//.test(posix)) score -= 10;
  if (/\.(md|txt|csv|json|yaml|yml|xml|snap)$/.test(base) && !HIGH_PRIORITY_BASENAMES.has(base)) score -= 8;
  return score;
}
