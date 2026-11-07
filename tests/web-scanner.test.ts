import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { scanWeb, buildPageDigest } from '../src/scanners/web/index.js';
import { detectWebTech } from '../src/scanners/web/inventory.js';
import { detectWebOwnership } from '../src/scanners/web/ownership.js';
import type { CrawledPage } from '../src/scanners/web/crawler.js';
import { WebConfigSchema } from '../src/config/schema.js';
import { setLogLevel } from '../src/util/logger.js';

setLogLevel('silent');

const PAGES: Record<string, string> = {
  '/': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme Widgets</title>
<meta name="generator" content="WordPress 6.5"><meta name="author" content="Acme Web Team">
<meta property="og:site_name" content="Acme Widgets">
<script src="/wp-content/themes/acme/jquery-3.7.1.min.js"></script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme Corporation","url":"https://acme.example","email":"hello@acme.example"}</script>
</head><body>
<h1>Welcome</h1>
<img src="/logo.png">
<nav><a href="/about">About</a> <a href="/contact">Contact</a> <a href="https://github.com/acme/widgets">Source</a></nav>
<form method="post" action="/login"><input name="email" type="email"><input name="password" type="password"><button>Go</button></form>
<footer>&copy; 2024 Acme Corporation. All rights reserved. <a href="mailto:support@acme.example">Email us</a> <a href="/privacy">Privacy</a></footer>
<script>window.dataLayer = window.dataLayer || []; console.error('boom');</script>
</body></html>`,
  '/about': `<!doctype html><html lang="en"><head><title>About</title></head><body><h1>About</h1><a href="/">Home</a><a href="/missing">Broken</a></body></html>`,
  '/contact': `<!doctype html><html><head><title>Contact</title></head><body><p>Call us</p></body></html>`,
  '/robots.txt': 'User-agent: *\nDisallow: /admin\n',
  '/.well-known/security.txt': 'Contact: mailto:security@acme.example\nExpires: 2030-01-01T00:00:00.000Z\n',
};

let server: http.Server;
let origin: string;
let chromiumAvailable = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const body = PAGES[url];
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><body>404</body></html>');
      return;
    }
    const isText = url.endsWith('.txt');
    res.writeHead(200, {
      'content-type': isText ? 'text/plain' : 'text/html',
      server: 'nginx/1.25.3',
      'x-powered-by': 'PHP/8.2.0',
      'set-cookie': ['PHPSESSID=abc; Path=/', '_ga=1; Path=/'],
      'strict-transport-security': 'max-age=63072000',
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
    chromiumAvailable = true;
  } catch {
    chromiumAvailable = false;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('scanWeb (requires Chromium)', () => {
  it('crawls same-origin pages and extracts facts, tech, ownership, and axe results', async (ctx) => {
    if (!chromiumAvailable) ctx.skip();
    const config = WebConfigSchema.parse({ maxPages: 3, maxDepth: 2, timeoutMs: 15_000 });
    const result = await scanWeb({ url: origin, config });

    expect(result.target.kind).toBe('web');
    expect(result.items.length).toBe(3);
    const ids = result.items.map((i) => i.id);
    expect(ids[0]).toBe(`${origin}/`);
    expect(ids).toContain(`${origin}/about`);

    const home = result.items[0]!;
    expect(home.meta?.status).toBe(200);
    expect(home.content).toContain('Title: Acme Widgets');
    expect(home.content).toContain('strict-transport-security');
    expect(home.content).toMatch(/missing: content-security-policy/);
    expect(home.content).toContain('PHPSESSID');
    expect(home.content).toMatch(/POST .*\/login \[no csrf token\]/);
    expect(home.content).toContain('email:email, password:password');
    expect(home.content).toContain('## Console errors');
    expect(home.content).toContain('boom');
    expect(home.content).toContain('framework globals: dataLayer');

    const tech = result.tech.map((t) => t.name);
    expect(tech).toEqual(expect.arrayContaining(['nginx', 'PHP', 'WordPress', 'jQuery', 'Google Analytics', 'Google Tag Manager']));
    expect(result.tech.find((t) => t.name === 'nginx')!.version).toBe('1.25.3');
    expect(result.tech.find((t) => t.name === 'WordPress')!.version).toBe('6.5');
    expect(result.tech.find((t) => t.name === 'jQuery')!.version).toBe('3.7.1');

    const own = (kind: string) => result.ownership.filter((o) => o.kind === kind).map((o) => o.value);
    expect(own('copyright').some((v) => /2024 Acme Corporation/.test(v))).toBe(true);
    expect(own('organization')).toContain('Acme Corporation');
    expect(own('email')).toContain('support@acme.example');
    expect(own('email')).toContain('hello@acme.example');
    expect(own('security-contact')).toContain('mailto:security@acme.example');
    expect(own('repository').some((v) => /github\.com\/acme\/widgets/.test(v))).toBe(true);
    expect(own('author')).toContain('Acme Web Team');

    expect(result.accessibility!.length).toBeGreaterThan(0);
    const homeAxe = result.accessibility!.find((a) => a.url === `${origin}/`)!;
    expect(homeAxe.violations.some((v) => v.id === 'image-alt')).toBe(true);
    expect(home.content).toContain('## Accessibility (axe-core)');

    expect(result.notes.some((n) => /robots\.txt found \(1 Disallow/.test(n))).toBe(true);
    expect(result.notes.some((n) => /security\.txt found/.test(n))).toBe(true);

    const contact = result.items.find((i) => i.id.endsWith('/contact'))!;
    expect(contact.content).toContain('lang=(unset)');
  }, 90_000);
});

describe('web inventory / ownership on synthetic pages (no browser)', () => {
  const page: CrawledPage = {
    url: 'https://shop.example/',
    finalUrl: 'https://shop.example/',
    depth: 0,
    status: 200,
    headers: { 'cf-ray': 'abc', 'x-vercel-id': 'v', server: 'cloudflare' },
    title: 'Shop',
    meta: { generator: 'Hugo 0.125.0' },
    lang: 'en',
    html: '<div id="__next"><a href="mailto:a@shop.example">mail</a><div class="flex px-4 py-2 mt-2 rounded">x</div></div>',
    htmlBytes: 100,
    text: 'Shop. © 2023-2025 Shop Example Ltd Privacy',
    internalLinks: [],
    externalLinkHosts: [],
    forms: [],
    scripts: ['https://shop.example/_next/static/chunks/main.js', 'https://www.googletagmanager.com/gtag/js?id=G-1', 'https://js.stripe.com/v3/'],
    inlineScriptCount: 0,
    inlineScriptSample: '',
    stylesheets: [],
    cookies: [{ name: '__cf_bm', domain: 'shop.example', secure: true, httpOnly: true, sameSite: 'None', session: true }],
    thirdPartyHosts: [],
    consoleErrors: [],
    failedRequests: [],
    mixedContent: [],
    globals: ['__NEXT_DATA__', 'angular@17.1.0'],
    jsonLd: [{ '@type': 'WebSite', name: 'Shop Example' }],
    loadTimeMs: 10,
  };

  it('fingerprints from headers, urls, globals, cookies, generator and html', () => {
    const tech = detectWebTech([page]);
    const names = tech.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['Cloudflare', 'Vercel', 'Next.js', 'Hugo', 'Google Analytics', 'Stripe', 'Angular', 'Tailwind CSS']));
    expect(tech.find((t) => t.name === 'Angular')!.version).toBe('17.1.0');
    expect(tech.find((t) => t.name === 'Hugo')!.version).toBe('0.125.0');
    // deduped: Cloudflare appears from cf-ray, server header and cookie but once in the list
    expect(names.filter((n) => n === 'Cloudflare')).toHaveLength(1);
  });

  it('extracts footer copyright, mailto, JSON-LD and well-known data', () => {
    const own = detectWebOwnership([page], { humansTxt: '/* TEAM */\nDeveloper: Dana Dev\nContact: dana@shop.example\n' });
    const by = (kind: string) => own.filter((o) => o.kind === kind).map((o) => o.value);
    expect(by('copyright')).toContain('2023-2025 Shop Example Ltd');
    expect(by('email')).toEqual(expect.arrayContaining(['a@shop.example', 'dana@shop.example']));
    expect(by('organization')).toContain('Shop Example');
    expect(by('author')).toContain('Dana Dev');
  });

  it('builds a digest with the key sections', () => {
    const digest = buildPageDigest(page);
    expect(digest).toContain('URL: https://shop.example/');
    expect(digest).toContain('## Cookies');
    expect(digest).toContain('__cf_bm');
    expect(digest).toContain('## Rendered HTML (reduced)');
  });
});
