/**
 * @module scanners/web/ownership
 *
 * Ownership indicators for live sites: footer copyright lines, `<meta
 * author>`, Open Graph site name, JSON-LD Organization/Person data, mailto
 * links, well-known files (`/.well-known/security.txt`, `/humans.txt`),
 * and links to legal pages (privacy, terms, imprint) which usually name the
 * legal entity.
 */

import type { OwnershipSignal } from '../types.js';
import type { CrawledPage } from './crawler.js';
import { dedupeOwnership, findCopyrights } from '../code/ownership.js';
import { log } from '../../util/logger.js';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Fetched contents of well-known files. */
export interface WellKnownFiles {
  securityTxt?: string;
  humansTxt?: string;
  robotsTxt?: string;
}

/**
 * Fetches `/.well-known/security.txt`, `/security.txt`, `/humans.txt` and
 * `/robots.txt` with plain HTTP (no browser needed). Missing files are
 * simply absent from the result.
 */
export async function fetchWellKnown(origin: string, userAgent: string, timeoutMs = 10_000, fetchFn: typeof fetch = fetch): Promise<WellKnownFiles> {
  const out: WellKnownFiles = {};
  const get = async (path: string): Promise<string | undefined> => {
    try {
      const res = await fetchFn(`${origin}${path}`, { headers: { 'user-agent': userAgent }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (!res.ok) return undefined;
      const type = res.headers.get('content-type') ?? '';
      if (!/text\/plain|text\/|application\/octet-stream/.test(type) && type) return undefined;
      const text = await res.text();
      // Many servers return the HTML 404 page with a 200; reject anything HTML-ish.
      if (/<html|<!doctype/i.test(text.slice(0, 200))) return undefined;
      return text.slice(0, 5000);
    } catch (err) {
      log.debug(`well-known ${path}: ${(err as Error).message}`);
      return undefined;
    }
  };
  out.securityTxt = (await get('/.well-known/security.txt')) ?? (await get('/security.txt'));
  out.humansTxt = await get('/humans.txt');
  out.robotsTxt = await get('/robots.txt');
  return out;
}

/** Extracts ownership signals from crawled pages and well-known files. */
export function detectWebOwnership(pages: CrawledPage[], wellKnown: WellKnownFiles = {}): OwnershipSignal[] {
  const out: OwnershipSignal[] = [];

  for (const page of pages) {
    const src = page.finalUrl || page.url;

    if (page.meta.author) out.push({ kind: 'author', value: page.meta.author, source: src, context: 'meta author', confidence: 0.85 });
    if (page.meta['og:site_name']) out.push({ kind: 'organization', value: page.meta['og:site_name'], source: src, context: 'og:site_name', confidence: 0.8 });
    if (page.meta['application-name']) out.push({ kind: 'organization', value: page.meta['application-name'], source: src, context: 'application-name', confidence: 0.6 });
    if (page.meta.copyright) out.push({ kind: 'copyright', value: page.meta.copyright, source: src, context: 'meta copyright', confidence: 0.9 });
    if (page.meta['twitter:site']) out.push({ kind: 'contact', value: page.meta['twitter:site'], source: src, context: 'twitter:site', confidence: 0.6 });

    // Copyright lines, typically in the footer; the last matches in the text are the most likely.
    const tail = page.text.slice(-3000);
    for (const c of findCopyrights(tail)) {
      const holder = cleanFooterHolder(c.holder);
      if (holder) out.push({ kind: 'copyright', value: `${c.year ? `${c.year} ` : ''}${holder}`, source: src, context: 'page footer text', confidence: 0.9 });
    }

    for (const m of page.html.matchAll(/href="mailto:([^"?]+)/gi)) {
      if (!isNoise(m[1]!)) out.push({ kind: 'email', value: m[1]!.toLowerCase(), source: src, context: 'mailto link', confidence: 0.85 });
    }
    for (const m of page.text.matchAll(EMAIL_RE)) {
      if (!isNoise(m[0])) out.push({ kind: 'email', value: m[0].toLowerCase(), source: src, context: 'page text', confidence: 0.6 });
    }
    for (const m of page.html.matchAll(/href="tel:([^"]+)"/gi)) {
      out.push({ kind: 'contact', value: m[1]!, source: src, context: 'tel link', confidence: 0.7 });
    }

    for (const m of page.html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]{0,60})<\/a>/gi)) {
      const [, href, label] = m;
      if (/privacy|terms|imprint|impressum|legal|about(-us)?|contact/i.test(`${href} ${label}`)) {
        out.push({ kind: 'legal', value: `${label!.trim() || href} -> ${href}`.slice(0, 160), source: src, context: 'legal/contact page link', confidence: 0.5 });
      }
      if (/github\.com\/|gitlab\.com\/|bitbucket\.org\//i.test(href!)) {
        out.push({ kind: 'repository', value: href!, source: src, context: 'link', confidence: 0.6 });
      }
      if (/linkedin\.com\/(company|in)\/|twitter\.com\/|x\.com\/|facebook\.com\/|instagram\.com\//i.test(href!)) {
        out.push({ kind: 'contact', value: href!, source: src, context: 'social link', confidence: 0.6 });
      }
    }

    for (const block of page.jsonLd) walkJsonLd(block, src, out);
  }

  if (wellKnown.securityTxt) {
    for (const m of wellKnown.securityTxt.matchAll(/^Contact:\s*(.+)$/gim)) out.push({ kind: 'security-contact', value: m[1]!.trim(), source: '/.well-known/security.txt', confidence: 0.95 });
    for (const m of wellKnown.securityTxt.matchAll(/^(Policy|Hiring|Canonical):\s*(.+)$/gim)) out.push({ kind: 'legal', value: `${m[1]}: ${m[2]!.trim()}`, source: '/.well-known/security.txt', confidence: 0.8 });
  }
  if (wellKnown.humansTxt) {
    for (const line of wellKnown.humansTxt.split(/\r?\n/).slice(0, 40)) {
      const t = line.trim();
      const m = t.match(/^(?:name|developer|author|team|company|owner|site|contact|twitter|github)\s*[:\-]\s*(.+)$/i);
      if (m) out.push({ kind: 'author', value: m[1]!.trim(), source: '/humans.txt', context: t.slice(0, 80), confidence: 0.85 });
    }
    for (const m of wellKnown.humansTxt.matchAll(EMAIL_RE)) if (!isNoise(m[0])) out.push({ kind: 'email', value: m[0].toLowerCase(), source: '/humans.txt', confidence: 0.85 });
  }

  return dedupeOwnership(out);
}

/** Recursively walks JSON-LD looking for Organization / Person / WebSite nodes. */
function walkJsonLd(node: unknown, src: string, out: OwnershipSignal[], depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) {
    for (const n of node) walkJsonLd(n, src, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const type = String(obj['@type'] ?? '');
  const name = typeof obj.name === 'string' ? obj.name : undefined;
  if (/Organization|Corporation|LocalBusiness|NGO|EducationalOrganization|GovernmentOrganization/i.test(type) && name) {
    out.push({ kind: 'organization', value: name, source: src, context: `JSON-LD ${type}`, confidence: 0.95 });
    if (typeof obj.url === 'string') out.push({ kind: 'domain', value: obj.url, source: src, context: `JSON-LD ${type}.url`, confidence: 0.8 });
    if (typeof obj.email === 'string') out.push({ kind: 'email', value: obj.email, source: src, context: `JSON-LD ${type}.email`, confidence: 0.9 });
    if (typeof obj.telephone === 'string') out.push({ kind: 'contact', value: obj.telephone, source: src, context: `JSON-LD ${type}.telephone`, confidence: 0.85 });
  }
  if (/Person/i.test(type) && name) out.push({ kind: 'author', value: name, source: src, context: 'JSON-LD Person', confidence: 0.85 });
  if (/WebSite/i.test(type) && name) out.push({ kind: 'organization', value: name, source: src, context: 'JSON-LD WebSite.name', confidence: 0.7 });
  const author = obj.author ?? obj.publisher ?? obj.creator;
  if (author) walkJsonLd(author, src, out, depth + 1);
  for (const key of ['@graph', 'mainEntity', 'itemListElement']) if (obj[key]) walkJsonLd(obj[key], src, out, depth + 1);
}

/** Footer lines run several items together; cut at the usual separators. */
function cleanFooterHolder(raw: string): string | undefined {
  const v = raw
    .replace(/\s*(all rights reserved|privacy|terms|cookie|sitemap|contact us).*$/i, '')
    .replace(/[.,;:\s]+$/, '')
    .trim();
  if (v.length < 2 || /^(the|and|or|of|by)$/i.test(v)) return undefined;
  return v.slice(0, 80);
}

function isNoise(email: string): boolean {
  return /(example\.(com|org)|sentry\.io|noreply|no-reply|wixpress|w3\.org|schema\.org|\.png$|\.jpg$|\.svg$)/i.test(email);
}
