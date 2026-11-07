/**
 * @module scanners/web/crawler
 *
 * Playwright-based crawler. Starting from one URL it performs a breadth-first
 * walk of same-origin links up to `maxPages` / `maxDepth`, capturing for each
 * page the rendered DOM plus the surrounding facts a reviewer would want:
 * response headers, cookies and their flags, forms, scripts, third-party
 * hosts contacted, console errors, failed requests, and mixed content.
 *
 * Only Chromium is used. Run `pnpm exec playwright install chromium` once.
 */

import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright';
import type { WebConfig } from '../../config/schema.js';
import type { AxePageSummary } from '../types.js';
import { runAxe } from './axe.js';
import { log } from '../../util/logger.js';

/** A form discovered on a page. */
export interface CrawledForm {
  action: string;
  method: string;
  /** Field names and types, e.g. `email:email`, `password:password`. */
  fields: string[];
  /** True when a hidden field looks like a CSRF token. */
  hasCsrfToken: boolean;
  /** True when the form posts to a different origin or over plain HTTP. */
  crossOriginOrInsecure: boolean;
}

/** A cookie observed after loading a page. */
export interface CrawledCookie {
  name: string;
  domain: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  /** Session cookie when no expiry is set. */
  session: boolean;
}

/** Everything captured for one page. */
export interface CrawledPage {
  url: string;
  finalUrl: string;
  depth: number;
  status: number | null;
  /** Response headers of the main document, lower-cased. */
  headers: Record<string, string>;
  title: string;
  /** Selected `<meta>` values keyed by name/property. */
  meta: Record<string, string>;
  /** `lang` attribute of `<html>`. */
  lang: string | null;
  /** Rendered HTML, reduced (scripts/styles/SVG removed, whitespace collapsed). */
  html: string;
  /** Size in bytes of the full rendered HTML before reduction. */
  htmlBytes: number;
  /** Visible text content, truncated. */
  text: string;
  /** Same-origin links found (absolute, de-duplicated, no fragments). */
  internalLinks: string[];
  /** External link hostnames. */
  externalLinkHosts: string[];
  forms: CrawledForm[];
  /** External script URLs. */
  scripts: string[];
  /** Number of inline `<script>` blocks and a sample of their content. */
  inlineScriptCount: number;
  inlineScriptSample: string;
  stylesheets: string[];
  cookies: CrawledCookie[];
  /** Hosts (other than the page origin) that received requests while loading. */
  thirdPartyHosts: string[];
  consoleErrors: string[];
  failedRequests: string[];
  /** `http://` resources loaded by an `https://` page. */
  mixedContent: string[];
  /** Presence of well-known framework globals, e.g. `__NEXT_DATA__`. */
  globals: string[];
  /** JSON-LD blocks (parsed), useful for Organization / author data. */
  jsonLd: unknown[];
  loadTimeMs: number;
  axe?: AxePageSummary;
  error?: string;
}

/** Options for {@link crawlSite}. */
export interface CrawlOptions extends Pick<WebConfig, 'maxPages' | 'maxDepth' | 'timeoutMs' | 'userAgent' | 'headless' | 'runAxe'> {
  startUrl: string;
  /** Progress callback. */
  onPage?: (page: CrawledPage, index: number, total: number) => void;
}

/** Result of {@link crawlSite}. */
export interface CrawlResult {
  pages: CrawledPage[];
  /** URLs discovered but not visited because of the page cap. */
  unvisited: string[];
  notes: string[];
}

/** Window globals whose presence identifies a framework or library. */
const KNOWN_GLOBALS = [
  '__NEXT_DATA__',
  '__NUXT__',
  '__remixContext',
  '__SVELTEKIT__',
  '___gatsby',
  '__astro',
  'React',
  'ReactDOM',
  'Vue',
  'angular',
  'ng',
  'jQuery',
  '$',
  'Ember',
  'Backbone',
  'Shopify',
  'wp',
  'Drupal',
  'Squarespace',
  'Wix',
  'webflow',
  'dataLayer',
  'gtag',
  'ga',
  'fbq',
  'hj',
  'Intercom',
  'analytics',
  'mixpanel',
  'amplitude',
  'Sentry',
  '__REDUX_DEVTOOLS_EXTENSION__',
  'Stripe',
  'firebase',
  'supabase',
];

/**
 * Crawls a site starting at `startUrl`.
 *
 * Pages that fail to load are still recorded (with `error` set) so the report
 * can mention broken links discovered during the crawl.
 */
export async function crawlSite(opts: CrawlOptions): Promise<CrawlResult> {
  const start = normaliseUrl(opts.startUrl, opts.startUrl);
  if (!start) throw new Error(`Invalid start URL: ${opts.startUrl}`);
  const origin = new URL(start).origin;

  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: opts.headless });
  } catch (err) {
    throw new Error(
      `Could not launch Chromium. Run "pnpm exec playwright install chromium" first. (${(err as Error).message.split('\n')[0]})`,
    );
  }

  const notes: string[] = [];
  const pages: CrawledPage[] = [];
  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
  const seen = new Set<string>([start]);

  try {
    const context = await browser.newContext({
      userAgent: opts.userAgent,
      ignoreHTTPSErrors: true,
      viewport: { width: 1366, height: 900 },
    });
    // tsx/esbuild keepNames injects `__name(fn, "...")` into functions that
    // `page.evaluate` serialises into the browser, where that helper does not
    // exist. Define a no-op so DOM extraction works when run via `tsx`.
    await context.addInitScript('globalThis.__name = globalThis.__name || function (f) { return f; };');

    while (queue.length && pages.length < opts.maxPages) {
      const { url, depth } = queue.shift()!;
      const crawled = await crawlOne(context, url, depth, origin, opts);
      pages.push(crawled);
      opts.onPage?.(crawled, pages.length, Math.min(opts.maxPages, pages.length + queue.length));

      if (depth < opts.maxDepth) {
        for (const link of crawled.internalLinks) {
          if (seen.has(link)) continue;
          seen.add(link);
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }

    await context.close();
  } finally {
    await browser.close();
  }

  const unvisited = queue.map((q) => q.url);
  if (unvisited.length) notes.push(`${unvisited.length} discovered URL(s) not visited (maxPages=${opts.maxPages})`);
  const errored = pages.filter((p) => p.error).length;
  if (errored) notes.push(`${errored} page(s) failed to load`);
  return { pages, unvisited, notes };
}

/** Visits a single URL and captures everything we care about. */
async function crawlOne(context: BrowserContext, url: string, depth: number, origin: string, opts: CrawlOptions): Promise<CrawledPage> {
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const thirdParty = new Set<string>();
  const mixed = new Set<string>();
  const isHttps = url.startsWith('https://');

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(trim(msg.text(), 300));
  });
  page.on('pageerror', (err) => consoleErrors.push(trim(`Uncaught: ${err.message}`, 300)));
  page.on('requestfailed', (req) => failedRequests.push(trim(`${req.method()} ${req.url()} - ${req.failure()?.errorText ?? 'failed'}`, 300)));
  page.on('request', (req) => {
    try {
      const u = new URL(req.url());
      if (u.origin !== origin && /^https?:$/.test(u.protocol)) thirdParty.add(u.host);
      if (isHttps && u.protocol === 'http:') mixed.add(req.url());
    } catch {
      /* data: / blob: urls */
    }
  });

  const started = Date.now();
  let response: Response | null = null;
  let error: string | undefined;
  try {
    response = await page.goto(url, { waitUntil: 'load', timeout: opts.timeoutMs });
    // Give SPAs a moment to hydrate; bounded so slow sites do not stall the crawl.
    await page.waitForLoadState('networkidle', { timeout: Math.min(opts.timeoutMs, 8000) }).catch(() => undefined);
  } catch (err) {
    error = (err as Error).message.split('\n')[0];
  }
  const loadTimeMs = Date.now() - started;

  const base: CrawledPage = {
    url,
    finalUrl: page.url() || url,
    depth,
    status: response?.status() ?? null,
    headers: response ? lowerKeys(response.headers()) : {},
    title: '',
    meta: {},
    lang: null,
    html: '',
    htmlBytes: 0,
    text: '',
    internalLinks: [],
    externalLinkHosts: [],
    forms: [],
    scripts: [],
    inlineScriptCount: 0,
    inlineScriptSample: '',
    stylesheets: [],
    cookies: [],
    thirdPartyHosts: [],
    consoleErrors,
    failedRequests,
    mixedContent: [],
    globals: [],
    jsonLd: [],
    loadTimeMs,
    error,
  };

  try {
    const extracted = await extractFromDom(page, origin);
    Object.assign(base, extracted);
    const cookies = await context.cookies();
    base.cookies = cookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      session: c.expires === -1,
    }));
    if (opts.runAxe && !error) {
      try {
        base.axe = await runAxe(page);
      } catch (err) {
        log.debug(`axe failed on ${url}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    base.error = base.error ?? `extraction failed: ${(err as Error).message.split('\n')[0]}`;
  } finally {
    await page.close().catch(() => undefined);
  }

  base.thirdPartyHosts = [...thirdParty].sort();
  base.mixedContent = [...mixed];
  return base;
}

/** Runs inside the page to pull out structured facts from the live DOM. */
async function extractFromDom(page: Page, origin: string): Promise<Partial<CrawledPage>> {
  const raw = await page.evaluate(
    ({ origin, knownGlobals }) => {
      const abs = (href: string): string | null => {
        try {
          return new URL(href, location.href).toString();
        } catch {
          return null;
        }
      };
      const meta: Record<string, string> = {};
      for (const m of Array.from(document.querySelectorAll('meta'))) {
        const key = m.getAttribute('name') ?? m.getAttribute('property') ?? m.getAttribute('http-equiv');
        const content = m.getAttribute('content');
        if (key && content) meta[key.toLowerCase()] = content.slice(0, 300);
      }

      const internal = new Set<string>();
      const externalHosts = new Set<string>();
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const href = a.getAttribute('href') ?? '';
        if (/^(mailto|tel|javascript|#)/i.test(href)) continue;
        const u = abs(href);
        if (!u) continue;
        try {
          const parsed = new URL(u);
          parsed.hash = '';
          if (parsed.origin === origin) {
            if (!/\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|mp3|docx?|xlsx?)$/i.test(parsed.pathname)) internal.add(parsed.toString());
          } else if (/^https?:$/.test(parsed.protocol)) {
            externalHosts.add(parsed.host);
          }
        } catch {
          /* ignore */
        }
      }

      const forms = Array.from(document.querySelectorAll('form')).map((f) => {
        const action = abs(f.getAttribute('action') ?? location.href) ?? location.href;
        const fields = Array.from(f.querySelectorAll('input,select,textarea')).map((el) => {
          const name = el.getAttribute('name') ?? el.getAttribute('id') ?? '(unnamed)';
          const type = el.tagName === 'INPUT' ? (el.getAttribute('type') ?? 'text') : el.tagName.toLowerCase();
          return `${name}:${type}`;
        });
        const hasCsrfToken = Array.from(f.querySelectorAll('input[type=hidden]')).some((el) =>
          /csrf|xsrf|token|authenticity|__requestverificationtoken|_token/i.test(el.getAttribute('name') ?? ''),
        );
        let crossOriginOrInsecure = false;
        try {
          const a = new URL(action);
          crossOriginOrInsecure = a.origin !== origin || (location.protocol === 'https:' && a.protocol === 'http:');
        } catch {
          /* ignore */
        }
        return { action, method: (f.getAttribute('method') ?? 'get').toLowerCase(), fields: fields.slice(0, 30), hasCsrfToken, crossOriginOrInsecure };
      });

      const scriptEls = Array.from(document.querySelectorAll('script'));
      const scripts = scriptEls.map((s) => s.getAttribute('src')).filter((s): s is string => !!s).map((s) => abs(s) ?? s);
      const inline = scriptEls.filter((s) => !s.getAttribute('src') && (s.getAttribute('type') ?? 'text/javascript').includes('javascript') || (!s.getAttribute('src') && s.getAttribute('type') === 'module'));
      const inlineSample = inline
        .map((s) => (s.textContent ?? '').trim())
        .filter(Boolean)
        .slice(0, 5)
        .map((t) => t.slice(0, 600))
        .join('\n/* --- */\n');

      const jsonLd: unknown[] = [];
      for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try {
          jsonLd.push(JSON.parse(s.textContent ?? ''));
        } catch {
          /* ignore */
        }
      }

      const stylesheets = Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]'))
        .map((l) => abs(l.getAttribute('href') ?? ''))
        .filter((s): s is string => !!s);

      const globals = knownGlobals.filter((g) => {
        try {
          return (window as unknown as Record<string, unknown>)[g] !== undefined;
        } catch {
          return false;
        }
      });
      const ngVersion = document.querySelector('[ng-version]')?.getAttribute('ng-version');
      if (ngVersion) globals.push(`angular@${ngVersion}`);
      if (document.querySelector('[data-reactroot], [data-reactid]')) globals.push('react-dom-markers');
      if (document.querySelector('#__next, #__nuxt, #___gatsby, #svelte, #app[data-v-app]')) globals.push('spa-root-marker');

      // Reduce the HTML: drop script/style/svg/noscript bodies and collapse whitespace.
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      for (const el of Array.from(clone.querySelectorAll('script,style,svg,noscript,template,iframe'))) {
        const placeholder = document.createComment(` ${el.tagName.toLowerCase()} removed `);
        el.replaceWith(placeholder);
      }
      const fullHtml = document.documentElement.outerHTML;
      const reduced = clone.outerHTML.replace(/\s{2,}/g, ' ').replace(/>\s+</g, '><');
      const text = (document.body?.innerText ?? '').replace(/\s{2,}/g, ' ').trim();

      return {
        title: document.title,
        meta,
        lang: document.documentElement.getAttribute('lang'),
        internalLinks: Array.from(internal).slice(0, 500),
        externalLinkHosts: Array.from(externalHosts).sort(),
        forms,
        scripts,
        inlineScriptCount: inline.length,
        inlineScriptSample: inlineSample,
        stylesheets,
        globals,
        jsonLd,
        html: reduced.slice(0, 120_000),
        htmlBytes: fullHtml.length,
        text: text.slice(0, 20_000),
      };
    },
    { origin, knownGlobals: KNOWN_GLOBALS },
  );
  return raw as Partial<CrawledPage>;
}

/** Normalises a URL for queueing: absolute, no fragment, trailing slash kept as-is. */
export function normaliseUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}
