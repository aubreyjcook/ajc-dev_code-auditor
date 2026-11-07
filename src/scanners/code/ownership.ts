/**
 * @module scanners/code/ownership
 *
 * Deterministic extraction of authorship and ownership indicators from a
 * codebase. These signals are surfaced verbatim in the report's "Ownership
 * indicators" section and handed to the LLM so its ownership summary is
 * grounded in concrete evidence.
 *
 * Sources considered:
 *  - `package.json` / `pyproject.toml` / `Cargo.toml` / `composer.json` author, maintainers, repository, homepage
 *  - LICENSE / COPYING files and copyright lines anywhere in the tree
 *  - `CODEOWNERS`, `AUTHORS`, `MAINTAINERS`, `SECURITY.md`, `.mailmap`
 *  - `@author` / `Copyright` / `(c)` header comments in source files
 *  - README mentions of organisations, contact emails, domains
 *  - git remote URL and git author statistics
 */

import path from 'node:path';
import type { GitAuthorStat, OwnershipSignal, ScanItem } from '../types.js';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const COPYRIGHT_RE = /(copyright\s*(?:\(c\)|©)?|\(c\)|©)\s*(\d{4}(?:\s*[-–,]\s*\d{4})?)?\s*(?:by\s+)?([^\n*/|]{2,80})/gi;
const AUTHOR_TAG_RE = /^[\s*/#-]*@author\s+([^\n*]{2,80})/gim;

/** A copyright statement located in text. */
export interface CopyrightMatch {
  year?: string;
  holder: string;
}

/**
 * Finds copyright statements. Prose that merely mentions the word
 * "copyright" is a common false positive (this very file, for instance), so
 * a match must carry a year or a (c)/© symbol; `requireYear` tightens that
 * further for source-file headers.
 */
export function findCopyrights(text: string, opts: { requireYear?: boolean } = {}): CopyrightMatch[] {
  const out: CopyrightMatch[] = [];
  for (const m of text.matchAll(COPYRIGHT_RE)) {
    const marker = m[1]!;
    const year = m[2];
    const hasSymbol = /\(c\)|©/i.test(marker);
    if (opts.requireYear ? !year : !year && !hasSymbol) continue;
    const holder = cleanHolder(m[3]);
    if (holder) out.push({ year, holder });
  }
  return out;
}

/** Emails that are placeholders / machine accounts and not real owners. */
const EMAIL_NOISE = /(example\.com|example\.org|noreply|no-reply|users\.noreply\.github\.com|localhost|sentry\.io|dependabot|renovate|github-actions)/i;

/**
 * Extracts ownership signals from collected files and optional git data.
 *
 * @param items - Files from `collectFiles`.
 * @param git - Optional git remote and author stats from `readRepoInfo`.
 */
export function detectCodeOwnership(items: ScanItem[], git?: { remote?: string; authors?: GitAuthorStat[] }): OwnershipSignal[] {
  const out: OwnershipSignal[] = [];

  for (const item of items) {
    const base = path.posix.basename(item.id).toLowerCase();

    if (base === 'package.json') fromPackageJson(item, out);
    if (base === 'pyproject.toml') fromPyproject(item, out);
    if (base === 'cargo.toml') fromCargo(item, out);
    if (base === 'composer.json') fromComposer(item, out);
    if (base === 'codeowners') fromCodeowners(item, out);
    if (/^(authors|maintainers|contributors)(\.md|\.txt)?$/.test(base)) fromAuthorsFile(item, out);
    if (/^(license|licence|copying)(\.md|\.txt)?$/.test(base) || base === 'notice') fromLicense(item, out);
    if (base === 'security.md' || item.id.toLowerCase() === '.github/security.md') fromSecurityMd(item, out);
    if (base === 'readme.md' || base === 'readme') fromReadme(item, out);

    // Source header comments: only look at the first ~40 lines to stay cheap.
    if (item.language && !['json', 'yaml', 'markdown', 'text', 'toml'].includes(item.language)) {
      fromSourceHeader(item, out);
    }
  }

  if (git?.remote) {
    out.push({ kind: 'repository', value: git.remote, source: 'git remote', confidence: 0.95 });
    const org = orgFromRemote(git.remote);
    if (org) out.push({ kind: 'organization', value: org, source: 'git remote', context: 'owner/org segment of the remote URL', confidence: 0.8 });
  }
  if (git?.authors?.length) {
    const total = git.authors.reduce((n, a) => n + a.commits, 0);
    for (const a of git.authors.slice(0, 10)) {
      const share = total ? Math.round((a.commits / total) * 100) : 0;
      out.push({
        kind: 'git-author',
        value: `${a.name} <${a.email}>`,
        source: 'git log',
        context: `${a.commits} commit(s), ${share}% of history${a.firstCommit ? `, ${a.firstCommit.slice(0, 10)} to ${a.lastCommit?.slice(0, 10)}` : ''}`,
        confidence: Math.min(0.95, 0.5 + share / 100),
      });
    }
  }

  return dedupeOwnership(out);
}

function fromPackageJson(item: ScanItem, out: OwnershipSignal[]): void {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(item.content) as Record<string, unknown>;
  } catch {
    return;
  }
  const person = (p: unknown): string | undefined => {
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object') {
      const o = p as { name?: string; email?: string; url?: string };
      return [o.name, o.email ? `<${o.email}>` : undefined, o.url ? `(${o.url})` : undefined].filter(Boolean).join(' ');
    }
    return undefined;
  };
  const author = person(pkg.author);
  if (author) out.push({ kind: 'author', value: author, source: item.id, context: 'package.json "author"', confidence: 0.95 });
  for (const m of (Array.isArray(pkg.maintainers) ? pkg.maintainers : []) as unknown[]) {
    const v = person(m);
    if (v) out.push({ kind: 'maintainer', value: v, source: item.id, context: 'package.json "maintainers"', confidence: 0.9 });
  }
  for (const c of (Array.isArray(pkg.contributors) ? pkg.contributors : []) as unknown[]) {
    const v = person(c);
    if (v) out.push({ kind: 'author', value: v, source: item.id, context: 'package.json "contributors"', confidence: 0.7 });
  }
  const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository as { url?: string } | undefined)?.url;
  if (repo) out.push({ kind: 'repository', value: repo, source: item.id, context: 'package.json "repository"', confidence: 0.9 });
  if (typeof pkg.homepage === 'string') out.push({ kind: 'domain', value: pkg.homepage, source: item.id, context: 'package.json "homepage"', confidence: 0.7 });
  if (typeof pkg.license === 'string') out.push({ kind: 'license', value: pkg.license, source: item.id, context: 'package.json "license"', confidence: 0.95 });
  if (typeof pkg.name === 'string' && pkg.name.startsWith('@')) {
    out.push({ kind: 'organization', value: pkg.name.split('/')[0]!.slice(1), source: item.id, context: 'npm scope in package name', confidence: 0.7 });
  }
}

function fromPyproject(item: ScanItem, out: OwnershipSignal[]): void {
  for (const m of item.content.matchAll(/\{\s*name\s*=\s*"([^"]+)"(?:\s*,\s*email\s*=\s*"([^"]+)")?\s*\}/g)) {
    out.push({ kind: 'author', value: m[2] ? `${m[1]} <${m[2]}>` : m[1]!, source: item.id, context: 'pyproject authors/maintainers', confidence: 0.9 });
  }
  const authors = item.content.match(/^authors\s*=\s*\[([^\]]*)\]/m)?.[1];
  if (authors) for (const m of authors.matchAll(/"([^"]+)"/g)) out.push({ kind: 'author', value: m[1]!, source: item.id, context: 'pyproject [tool.poetry] authors', confidence: 0.85 });
  const license = item.content.match(/^license\s*=\s*(?:\{\s*text\s*=\s*)?"([^"]+)"/m)?.[1];
  if (license) out.push({ kind: 'license', value: license, source: item.id, confidence: 0.9 });
  const home = item.content.match(/^(?:homepage|Homepage|repository|Repository)\s*=\s*"([^"]+)"/m)?.[1];
  if (home) out.push({ kind: 'repository', value: home, source: item.id, confidence: 0.8 });
}

function fromCargo(item: ScanItem, out: OwnershipSignal[]): void {
  const authors = item.content.match(/^authors\s*=\s*\[([^\]]*)\]/m)?.[1];
  if (authors) for (const m of authors.matchAll(/"([^"]+)"/g)) out.push({ kind: 'author', value: m[1]!, source: item.id, context: 'Cargo.toml authors', confidence: 0.9 });
  const license = item.content.match(/^license\s*=\s*"([^"]+)"/m)?.[1];
  if (license) out.push({ kind: 'license', value: license, source: item.id, confidence: 0.9 });
  const repo = item.content.match(/^repository\s*=\s*"([^"]+)"/m)?.[1];
  if (repo) out.push({ kind: 'repository', value: repo, source: item.id, confidence: 0.9 });
}

function fromComposer(item: ScanItem, out: OwnershipSignal[]): void {
  try {
    const c = JSON.parse(item.content) as { authors?: { name?: string; email?: string }[]; license?: string | string[]; homepage?: string; name?: string };
    for (const a of c.authors ?? []) {
      if (a.name) out.push({ kind: 'author', value: a.email ? `${a.name} <${a.email}>` : a.name, source: item.id, context: 'composer.json authors', confidence: 0.9 });
    }
    if (c.license) out.push({ kind: 'license', value: Array.isArray(c.license) ? c.license.join(', ') : c.license, source: item.id, confidence: 0.9 });
    if (c.homepage) out.push({ kind: 'domain', value: c.homepage, source: item.id, confidence: 0.7 });
    if (c.name?.includes('/')) out.push({ kind: 'organization', value: c.name.split('/')[0]!, source: item.id, context: 'composer vendor name', confidence: 0.7 });
  } catch {
    /* ignore malformed */
  }
}

function fromCodeowners(item: ScanItem, out: OwnershipSignal[]): void {
  const owners = new Set<string>();
  for (const line of item.content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    for (const tok of t.split(/\s+/).slice(1)) if (tok.startsWith('@') || tok.includes('@')) owners.add(tok);
  }
  for (const o of owners) out.push({ kind: 'codeowners', value: o, source: item.id, confidence: 0.9 });
}

function fromAuthorsFile(item: ScanItem, out: OwnershipSignal[]): void {
  for (const line of item.content.split(/\r?\n/).slice(0, 50)) {
    const t = line.replace(/^[-*#\s]+/, '').trim();
    if (t.length > 2 && t.length < 100 && !/^(authors|maintainers|contributors)$/i.test(t)) {
      out.push({ kind: 'author', value: t, source: item.id, confidence: 0.75 });
    }
  }
}

function fromLicense(item: ScanItem, out: OwnershipSignal[]): void {
  const head = item.content.slice(0, 2000);
  const name = detectLicenseName(head);
  if (name) out.push({ kind: 'license', value: name, source: item.id, confidence: 0.9 });
  for (const c of findCopyrights(head)) {
    out.push({ kind: 'copyright', value: `${c.year ? `${c.year} ` : ''}${c.holder}`, source: item.id, context: 'LICENSE copyright line', confidence: 0.95 });
  }
}

function fromSecurityMd(item: ScanItem, out: OwnershipSignal[]): void {
  for (const m of item.content.matchAll(EMAIL_RE)) {
    if (!EMAIL_NOISE.test(m[0])) out.push({ kind: 'security-contact', value: m[0], source: item.id, confidence: 0.85 });
  }
}

function fromReadme(item: ScanItem, out: OwnershipSignal[]): void {
  const text = item.content.slice(0, 20_000);
  for (const c of findCopyrights(text)) {
    out.push({ kind: 'copyright', value: `${c.year ? `${c.year} ` : ''}${c.holder}`, source: item.id, context: 'README', confidence: 0.8 });
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    if (!EMAIL_NOISE.test(m[0])) out.push({ kind: 'email', value: m[0], source: item.id, context: 'README', confidence: 0.6 });
  }
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?(github|gitlab|bitbucket)\.com\/([\w.-]+)\/([\w.-]+)/g)) {
    out.push({ kind: 'repository', value: m[0], source: item.id, context: 'README link', confidence: 0.6 });
  }
  const maintained = text.match(/(?:maintained|developed|built|created|made)\s+(?:with\s+\S+\s+)?by\s+([^\n.]{2,60})/i)?.[1];
  if (maintained) out.push({ kind: 'author', value: maintained.trim(), source: item.id, context: 'README "by" statement', confidence: 0.65 });
}

function fromSourceHeader(item: ScanItem, out: OwnershipSignal[]): void {
  const head = item.content.split(/\r?\n/).slice(0, 40).join('\n');
  for (const c of findCopyrights(head, { requireYear: true })) {
    if (looksLikeDocumentation(c.holder)) continue;
    out.push({ kind: 'copyright', value: `${c.year ? `${c.year} ` : ''}${c.holder}`, source: item.id, context: 'file header', confidence: 0.75 });
  }
  for (const m of head.matchAll(AUTHOR_TAG_RE)) {
    const value = m[1]!.trim();
    if (looksLikeDocumentation(value)) continue;
    out.push({ kind: 'author', value, source: item.id, context: '@author tag', confidence: 0.8 });
  }
}

/** True when a captured string is documentation *about* ownership, not a real holder. */
function looksLikeDocumentation(value: string): boolean {
  if (/[<>]/.test(value)) return true;
  if (/"/.test(value)) return true;
  if ((value.match(/,/g) ?? []).length >= 2) return true;
  if (/^(tags?|annotation|fields?|lines?|holders?|notice)\b/i.test(value)) return true;
  if (/copyright\s+holders?|license file|file header|@author/i.test(value)) return true;
  return false;
}

function cleanHolder(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw
    .replace(/\s+/g, ' ')
    .replace(/^(?:holders?|notice|\(c\)|©)\s*/i, '')
    .replace(/\s*(all rights reserved|licensed under|permission is hereby granted).*$/i, '')
    .replace(/[.,;:\s]+$/, '')
    .trim();
  if (v.length < 2 || /^(the|and|or|of|holders?|notice|year|owner|name)$/i.test(v)) return undefined;
  if (/^<?(year|name|fullname|copyright holders?)>?$/i.test(v)) return undefined;
  if (looksLikeDocumentation(v)) return undefined;
  return v;
}

/** Recognises common licenses from their opening text. */
export function detectLicenseName(text: string): string | undefined {
  const t = text.toLowerCase();
  if (/mit license/.test(t) || /permission is hereby granted, free of charge/.test(t)) return 'MIT';
  if (/apache license/.test(t) && /version 2\.0/.test(t)) return 'Apache-2.0';
  if (/gnu affero general public license/.test(t)) return 'AGPL-3.0';
  if (/gnu lesser general public license/.test(t)) return 'LGPL';
  if (/gnu general public license/.test(t)) return /version 3/.test(t) ? 'GPL-3.0' : 'GPL-2.0';
  if (/bsd 3-clause/.test(t) || (/redistribution and use in source and binary forms/.test(t) && /neither the name/.test(t))) return 'BSD-3-Clause';
  if (/bsd 2-clause/.test(t) || /redistribution and use in source and binary forms/.test(t)) return 'BSD-2-Clause';
  if (/mozilla public license/.test(t)) return 'MPL-2.0';
  if (/isc license/.test(t)) return 'ISC';
  if (/the unlicense/.test(t) || /this is free and unencumbered software/.test(t)) return 'Unlicense';
  if (/creative commons/.test(t)) return 'Creative Commons';
  if (/proprietary|all rights reserved/.test(t)) return 'Proprietary / All rights reserved';
  return undefined;
}

/** Extracts the `owner` segment from common git hosting URLs. */
export function orgFromRemote(remote: string): string | undefined {
  const m = remote.match(/(?:github|gitlab|bitbucket)\.(?:com|org)[/:]([\w.-]+)\//i) ?? remote.match(/dev\.azure\.com\/([\w.-]+)\//i);
  return m?.[1];
}

/** Removes duplicate (kind, value) pairs, keeping the highest confidence. */
export function dedupeOwnership(signals: OwnershipSignal[]): OwnershipSignal[] {
  const map = new Map<string, OwnershipSignal>();
  for (const s of signals) {
    const key = `${s.kind}|${s.value.toLowerCase().trim()}`;
    const existing = map.get(key);
    if (!existing || s.confidence > existing.confidence) map.set(key, s);
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence || a.kind.localeCompare(b.kind));
}
