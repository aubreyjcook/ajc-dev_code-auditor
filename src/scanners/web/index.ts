/**
 * @module scanners/web
 *
 * Orchestrates a live-site scan: crawls with Playwright, fetches well-known
 * files, fingerprints technologies, extracts ownership indicators, and turns
 * each page into a compact text digest that the LLM can review.
 */

import type { WebConfig } from '../../config/schema.js';
import type { ScanItem, ScanResult, ScanStats } from '../types.js';
import { crawlSite, type CrawledPage } from './crawler.js';
import { detectWebTech } from './inventory.js';
import { detectWebOwnership, fetchWellKnown } from './ownership.js';
import { formatAxeSummary } from './axe.js';
import { estimateTokens } from '../../llm/tokens.js';
import { log } from '../../util/logger.js';

export { crawlSite, normaliseUrl } from './crawler.js';
export type { CrawledPage, CrawledForm, CrawledCookie, CrawlResult } from './crawler.js';
export { detectWebTech } from './inventory.js';
export { detectWebOwnership, fetchWellKnown } from './ownership.js';
export { runAxe, formatAxeSummary } from './axe.js';

/** Options for {@link scanWeb}. */
export interface ScanWebOptions {
  url: string;
  config: WebConfig;
}

/** Headers reviewers care about; listed first in the digest. */
const INTERESTING_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'cross-origin-embedder-policy',
  'x-xss-protection',
  'set-cookie',
  'server',
  'x-powered-by',
  'cache-control',
  'content-type',
  'access-control-allow-origin',
];

/** Scans a live website. */
export async function scanWeb(opts: ScanWebOptions): Promise<ScanResult> {
  const started = Date.now();
  const startUrl = /^https?:\/\//i.test(opts.url) ? opts.url : `https://${opts.url}`;
  const origin = new URL(startUrl).origin;

  log.info(`Crawling ${startUrl} (max ${opts.config.maxPages} pages, depth ${opts.config.maxDepth})`);

  const [crawl, wellKnown] = await Promise.all([
    crawlSite({
      startUrl,
      ...opts.config,
      onPage: (p, i, total) => log.step(`[${i}/${total}] ${p.status ?? 'ERR'} ${p.finalUrl}${p.error ? ` (${p.error})` : ''}`),
    }),
    fetchWellKnown(origin, opts.config.userAgent, opts.config.timeoutMs),
  ]);

  const items: ScanItem[] = crawl.pages.map((p) => pageToItem(p));
  const tech = detectWebTech(crawl.pages);
  const ownership = detectWebOwnership(crawl.pages, wellKnown);

  const notes = [...crawl.notes];
  if (wellKnown.securityTxt) notes.push('security.txt found');
  if (wellKnown.humansTxt) notes.push('humans.txt found');
  if (wellKnown.robotsTxt) {
    const disallows = (wellKnown.robotsTxt.match(/^Disallow:/gim) ?? []).length;
    notes.push(`robots.txt found (${disallows} Disallow rule(s))`);
  }

  const byLanguage: Record<string, number> = {};
  let totalBytes = 0;
  let totalTokens = 0;
  for (const item of items) {
    const key = String(item.meta?.status ?? 'error');
    byLanguage[`http ${key}`] = (byLanguage[`http ${key}`] ?? 0) + 1;
    totalBytes += item.bytes;
    totalTokens += item.tokens;
  }
  const stats: ScanStats = {
    itemsScanned: items.length,
    itemsSkipped: crawl.unvisited.length,
    totalBytes,
    totalTokens,
    byLanguage,
    durationMs: Date.now() - started,
  };

  log.info(`Crawled ${items.length} page(s), ~${totalTokens.toLocaleString()} tokens; ${tech.length} tech signal(s), ${ownership.length} ownership signal(s)`);

  return {
    target: { kind: 'web', source: opts.url, resolved: startUrl },
    items,
    tech,
    ownership,
    stats,
    notes,
    accessibility: crawl.pages.filter((p) => p.axe).map((p) => p.axe!),
  };
}

/** Converts a crawled page into the digest text the model will read. */
export function pageToItem(p: CrawledPage): ScanItem {
  const content = buildPageDigest(p);
  return {
    kind: 'page',
    id: p.finalUrl || p.url,
    content,
    tokens: estimateTokens(content),
    bytes: p.htmlBytes,
    language: 'html',
    meta: {
      status: p.status,
      depth: p.depth,
      loadTimeMs: p.loadTimeMs,
      axeViolations: p.axe?.violations.length ?? null,
      error: p.error ?? null,
    },
  };
}

/**
 * Renders a page as structured text. Facts first (so they survive even if
 * the HTML is truncated by the chunker), then the reduced HTML.
 */
export function buildPageDigest(p: CrawledPage): string {
  const lines: string[] = [];
  lines.push(`URL: ${p.url}${p.finalUrl && p.finalUrl !== p.url ? ` -> ${p.finalUrl}` : ''}`);
  lines.push(`Status: ${p.status ?? 'no response'}${p.error ? ` | Error: ${p.error}` : ''} | Depth: ${p.depth} | Load: ${p.loadTimeMs}ms`);
  lines.push(`Title: ${p.title || '(none)'} | lang=${p.lang ?? '(unset)'}`);

  const metaKeys = ['description', 'viewport', 'generator', 'author', 'robots', 'og:site_name', 'og:type'];
  const meta = metaKeys.filter((k) => p.meta[k]).map((k) => `${k}="${p.meta[k]}"`);
  if (meta.length) lines.push(`Meta: ${meta.join(' ')}`);

  lines.push('', '## Response headers (security-relevant first)');
  const seen = new Set<string>();
  for (const h of INTERESTING_HEADERS) {
    if (p.headers[h]) {
      lines.push(`${h}: ${p.headers[h]!.slice(0, 300)}`);
      seen.add(h);
    }
  }
  const missing = ['content-security-policy', 'strict-transport-security', 'x-frame-options', 'x-content-type-options', 'referrer-policy'].filter((h) => !p.headers[h]);
  if (missing.length) lines.push(`(missing: ${missing.join(', ')})`);
  const others = Object.keys(p.headers).filter((k) => !seen.has(k)).slice(0, 15);
  if (others.length) lines.push(`other headers: ${others.join(', ')}`);

  if (p.cookies.length) {
    lines.push('', '## Cookies');
    for (const c of p.cookies.slice(0, 25)) {
      const flags = [c.secure ? 'Secure' : 'NOT secure', c.httpOnly ? 'HttpOnly' : 'NOT httpOnly', `SameSite=${c.sameSite}`, c.session ? 'session' : 'persistent'];
      lines.push(`- ${c.name} (${c.domain}): ${flags.join(', ')}`);
    }
  }

  if (p.forms.length) {
    lines.push('', '## Forms');
    for (const f of p.forms.slice(0, 15)) {
      lines.push(`- ${f.method.toUpperCase()} ${f.action}${f.hasCsrfToken ? ' [csrf token present]' : ' [no csrf token]'}${f.crossOriginOrInsecure ? ' [cross-origin or insecure action]' : ''}`);
      lines.push(`  fields: ${f.fields.join(', ') || '(none)'}`);
    }
  }

  lines.push('', '## Scripts & resources');
  lines.push(`external scripts (${p.scripts.length}): ${p.scripts.slice(0, 25).join(', ') || '(none)'}`);
  lines.push(`inline scripts: ${p.inlineScriptCount}`);
  lines.push(`stylesheets (${p.stylesheets.length}): ${p.stylesheets.slice(0, 10).join(', ') || '(none)'}`);
  lines.push(`third-party hosts contacted: ${p.thirdPartyHosts.slice(0, 40).join(', ') || '(none)'}`);
  if (p.globals.length) lines.push(`framework globals: ${p.globals.join(', ')}`);
  if (p.mixedContent.length) lines.push(`MIXED CONTENT (http on https): ${p.mixedContent.slice(0, 10).join(', ')}`);
  if (p.inlineScriptSample) lines.push('', '### Inline script sample', '```js', p.inlineScriptSample.slice(0, 2500), '```');

  if (p.consoleErrors.length) {
    lines.push('', '## Console errors');
    for (const e of p.consoleErrors.slice(0, 15)) lines.push(`- ${e}`);
  }
  if (p.failedRequests.length) {
    lines.push('', '## Failed requests');
    for (const e of p.failedRequests.slice(0, 15)) lines.push(`- ${e}`);
  }

  lines.push('', `## Links`, `internal (${p.internalLinks.length}): ${p.internalLinks.slice(0, 30).join(', ')}`, `external hosts: ${p.externalLinkHosts.slice(0, 30).join(', ') || '(none)'}`);

  if (p.axe) lines.push('', '## Accessibility (axe-core)', formatAxeSummary(p.axe));

  if (p.jsonLd.length) {
    lines.push('', '## JSON-LD');
    lines.push(JSON.stringify(p.jsonLd).slice(0, 2500));
  }

  lines.push('', '## Visible text (excerpt)', p.text.slice(0, 4000) || '(empty)');
  lines.push('', '## Rendered HTML (reduced)', '```html', p.html.slice(0, 60_000), '```');

  return lines.join('\n');
}
