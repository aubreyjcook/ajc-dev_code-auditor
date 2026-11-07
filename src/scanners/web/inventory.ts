/**
 * @module scanners/web/inventory
 *
 * Deterministic technology fingerprinting for live sites. Evidence comes from
 * response headers, cookies, `<meta generator>`, script and stylesheet URLs,
 * window globals, and HTML markers. Confidence reflects how specific the
 * marker is (a `cf-ray` header is unambiguous; a `$` global is not).
 */

import type { TechSignal } from '../types.js';
import type { CrawledPage } from './crawler.js';
import { dedupeSignals } from '../code/inventory.js';

interface Rule {
  name: string;
  category: TechSignal['category'];
  confidence: number;
}

const HEADER_RULES: { header: string; match?: RegExp; rule: Rule; versionFrom?: RegExp }[] = [
  { header: 'server', match: /nginx/i, rule: { name: 'nginx', category: 'server', confidence: 0.95 }, versionFrom: /nginx\/([\d.]+)/i },
  { header: 'server', match: /apache/i, rule: { name: 'Apache HTTP Server', category: 'server', confidence: 0.95 }, versionFrom: /apache\/([\d.]+)/i },
  { header: 'server', match: /microsoft-iis/i, rule: { name: 'Microsoft IIS', category: 'server', confidence: 0.95 }, versionFrom: /iis\/([\d.]+)/i },
  { header: 'server', match: /cloudflare/i, rule: { name: 'Cloudflare', category: 'cdn', confidence: 0.95 } },
  { header: 'server', match: /vercel/i, rule: { name: 'Vercel', category: 'infra', confidence: 0.95 } },
  { header: 'server', match: /netlify/i, rule: { name: 'Netlify', category: 'infra', confidence: 0.95 } },
  { header: 'server', match: /github\.com/i, rule: { name: 'GitHub Pages', category: 'infra', confidence: 0.95 } },
  { header: 'server', match: /litespeed/i, rule: { name: 'LiteSpeed', category: 'server', confidence: 0.95 } },
  { header: 'server', match: /caddy/i, rule: { name: 'Caddy', category: 'server', confidence: 0.95 } },
  { header: 'server', match: /gunicorn/i, rule: { name: 'Gunicorn', category: 'server', confidence: 0.95 } },
  { header: 'server', match: /uvicorn/i, rule: { name: 'Uvicorn', category: 'server', confidence: 0.95 } },
  { header: 'server', match: /kestrel/i, rule: { name: 'Kestrel (ASP.NET Core)', category: 'server', confidence: 0.95 } },
  { header: 'server', match: /cowboy/i, rule: { name: 'Cowboy (Erlang/Elixir)', category: 'server', confidence: 0.9 } },
  { header: 'server', match: /amazons3/i, rule: { name: 'Amazon S3', category: 'infra', confidence: 0.95 } },
  { header: 'server', match: /gse/i, rule: { name: 'Google Servers (GSE)', category: 'infra', confidence: 0.8 } },
  { header: 'x-powered-by', match: /express/i, rule: { name: 'Express', category: 'framework', confidence: 0.95 } },
  { header: 'x-powered-by', match: /next\.js/i, rule: { name: 'Next.js', category: 'framework', confidence: 0.95 } },
  { header: 'x-powered-by', match: /php/i, rule: { name: 'PHP', category: 'language', confidence: 0.95 }, versionFrom: /php\/([\d.]+)/i },
  { header: 'x-powered-by', match: /asp\.net/i, rule: { name: 'ASP.NET', category: 'framework', confidence: 0.95 } },
  { header: 'x-powered-by', match: /servlet|jsp/i, rule: { name: 'Java Servlet', category: 'framework', confidence: 0.9 } },
  { header: 'x-powered-by', match: /phusion passenger/i, rule: { name: 'Phusion Passenger', category: 'server', confidence: 0.95 } },
  { header: 'x-powered-by', match: /wp engine/i, rule: { name: 'WP Engine', category: 'infra', confidence: 0.95 } },
  { header: 'x-aspnet-version', rule: { name: 'ASP.NET', category: 'framework', confidence: 0.95 }, versionFrom: /([\d.]+)/ },
  { header: 'x-aspnetmvc-version', rule: { name: 'ASP.NET MVC', category: 'framework', confidence: 0.95 }, versionFrom: /([\d.]+)/ },
  { header: 'cf-ray', rule: { name: 'Cloudflare', category: 'cdn', confidence: 0.98 } },
  { header: 'cf-cache-status', rule: { name: 'Cloudflare', category: 'cdn', confidence: 0.98 } },
  { header: 'x-vercel-id', rule: { name: 'Vercel', category: 'infra', confidence: 0.98 } },
  { header: 'x-nf-request-id', rule: { name: 'Netlify', category: 'infra', confidence: 0.98 } },
  { header: 'x-amz-cf-id', rule: { name: 'Amazon CloudFront', category: 'cdn', confidence: 0.98 } },
  { header: 'x-amz-request-id', rule: { name: 'Amazon S3', category: 'infra', confidence: 0.9 } },
  { header: 'x-github-request-id', rule: { name: 'GitHub Pages', category: 'infra', confidence: 0.98 } },
  { header: 'x-served-by', match: /cache-/i, rule: { name: 'Fastly', category: 'cdn', confidence: 0.85 } },
  { header: 'x-fastly-request-id', rule: { name: 'Fastly', category: 'cdn', confidence: 0.98 } },
  { header: 'x-akamai-transformed', rule: { name: 'Akamai', category: 'cdn', confidence: 0.98 } },
  { header: 'x-azure-ref', rule: { name: 'Azure Front Door / CDN', category: 'cdn', confidence: 0.95 } },
  { header: 'x-drupal-cache', rule: { name: 'Drupal', category: 'cms', confidence: 0.98 } },
  { header: 'x-generator', match: /drupal/i, rule: { name: 'Drupal', category: 'cms', confidence: 0.98 } },
  { header: 'x-shopify-stage', rule: { name: 'Shopify', category: 'cms', confidence: 0.98 } },
  { header: 'x-wix-request-id', rule: { name: 'Wix', category: 'cms', confidence: 0.98 } },
  { header: 'x-sveltekit-page', rule: { name: 'SvelteKit', category: 'framework', confidence: 0.98 } },
  { header: 'x-nuxt-no-ssr', rule: { name: 'Nuxt', category: 'framework', confidence: 0.9 } },
  { header: 'x-render-origin-server', rule: { name: 'Render', category: 'infra', confidence: 0.98 } },
  { header: 'fly-request-id', rule: { name: 'Fly.io', category: 'infra', confidence: 0.98 } },
  { header: 'x-heroku-queue-wait-time', rule: { name: 'Heroku', category: 'infra', confidence: 0.98 } },
  { header: 'via', match: /heroku-router/i, rule: { name: 'Heroku', category: 'infra', confidence: 0.98 } },
  { header: 'via', match: /varnish/i, rule: { name: 'Varnish', category: 'cdn', confidence: 0.9 } },
  { header: 'x-varnish', rule: { name: 'Varnish', category: 'cdn', confidence: 0.95 } },
];

const COOKIE_RULES: { match: RegExp; rule: Rule }[] = [
  { match: /^phpsessid$/i, rule: { name: 'PHP', category: 'language', confidence: 0.95 } },
  { match: /^jsessionid$/i, rule: { name: 'Java Servlet', category: 'framework', confidence: 0.9 } },
  { match: /^asp\.net_sessionid$/i, rule: { name: 'ASP.NET', category: 'framework', confidence: 0.95 } },
  { match: /^\.aspnetcore\./i, rule: { name: 'ASP.NET Core', category: 'framework', confidence: 0.95 } },
  { match: /^csrftoken$/i, rule: { name: 'Django', category: 'framework', confidence: 0.85 } },
  { match: /^sessionid$/i, rule: { name: 'Django', category: 'framework', confidence: 0.5 } },
  { match: /^_rails_session|_session_id$/i, rule: { name: 'Ruby on Rails', category: 'framework', confidence: 0.8 } },
  { match: /^laravel_session$/i, rule: { name: 'Laravel', category: 'framework', confidence: 0.95 } },
  { match: /^xsrf-token$/i, rule: { name: 'Laravel / Angular XSRF', category: 'framework', confidence: 0.5 } },
  { match: /^connect\.sid$/i, rule: { name: 'Express (express-session)', category: 'framework', confidence: 0.9 } },
  { match: /^wordpress_|^wp-settings/i, rule: { name: 'WordPress', category: 'cms', confidence: 0.95 } },
  { match: /^_shopify_/i, rule: { name: 'Shopify', category: 'cms', confidence: 0.95 } },
  { match: /^__cf_bm$|^cf_clearance$/i, rule: { name: 'Cloudflare', category: 'cdn', confidence: 0.95 } },
  { match: /^_ga$|^_gid$|^_gat/i, rule: { name: 'Google Analytics', category: 'analytics', confidence: 0.95 } },
  { match: /^_fbp$/i, rule: { name: 'Meta Pixel', category: 'analytics', confidence: 0.95 } },
  { match: /^_hj/i, rule: { name: 'Hotjar', category: 'analytics', confidence: 0.95 } },
  { match: /^intercom-/i, rule: { name: 'Intercom', category: 'analytics', confidence: 0.95 } },
  { match: /^hubspotutk$|^__hs/i, rule: { name: 'HubSpot', category: 'analytics', confidence: 0.95 } },
  { match: /^ajs_/i, rule: { name: 'Segment', category: 'analytics', confidence: 0.9 } },
  { match: /^next-auth\./i, rule: { name: 'NextAuth.js', category: 'library', confidence: 0.95 } },
  { match: /^sb-.*-auth-token$/i, rule: { name: 'Supabase Auth', category: 'infra', confidence: 0.95 } },
];

const URL_RULES: { match: RegExp; rule: Rule; versionFrom?: RegExp }[] = [
  { match: /\/_next\/static\//, rule: { name: 'Next.js', category: 'framework', confidence: 0.98 } },
  { match: /\/_nuxt\//, rule: { name: 'Nuxt', category: 'framework', confidence: 0.98 } },
  { match: /\/_app\/immutable\//, rule: { name: 'SvelteKit', category: 'framework', confidence: 0.95 } },
  { match: /\/_astro\//, rule: { name: 'Astro', category: 'framework', confidence: 0.95 } },
  { match: /\/build\/_shared\/|\/build\/root-/, rule: { name: 'Remix', category: 'framework', confidence: 0.7 } },
  { match: /\/wp-content\/|\/wp-includes\//, rule: { name: 'WordPress', category: 'cms', confidence: 0.98 } },
  { match: /cdn\.shopify\.com/, rule: { name: 'Shopify', category: 'cms', confidence: 0.98 } },
  { match: /static\.parastorage\.com|wixstatic\.com/, rule: { name: 'Wix', category: 'cms', confidence: 0.98 } },
  { match: /squarespace\.com|sqsp\.net/, rule: { name: 'Squarespace', category: 'cms', confidence: 0.98 } },
  { match: /webflow\.com/, rule: { name: 'Webflow', category: 'cms', confidence: 0.95 } },
  { match: /\/sites\/default\/files\/|\/core\/misc\/drupal/, rule: { name: 'Drupal', category: 'cms', confidence: 0.95 } },
  { match: /\/media\/jui\/|\/media\/system\/js\//, rule: { name: 'Joomla', category: 'cms', confidence: 0.9 } },
  { match: /ghost\.(io|org)|\/assets\/built\//, rule: { name: 'Ghost', category: 'cms', confidence: 0.6 } },
  { match: /jquery(-|\.)?([\d.]+)?(\.min)?\.js/, rule: { name: 'jQuery', category: 'library', confidence: 0.95 }, versionFrom: /jquery[-.]?([\d.]+\d)/ },
  { match: /bootstrap(\.bundle)?(\.min)?\.(js|css)/, rule: { name: 'Bootstrap', category: 'library', confidence: 0.9 }, versionFrom: /bootstrap@([\d.]+)|bootstrap\/([\d.]+)/ },
  { match: /react(-dom)?(\.production)?(\.min)?\.js/, rule: { name: 'React', category: 'framework', confidence: 0.9 } },
  { match: /vue(\.runtime)?(\.global)?(\.prod)?(\.min)?\.js/, rule: { name: 'Vue', category: 'framework', confidence: 0.9 } },
  { match: /angular(\.min)?\.js/, rule: { name: 'AngularJS', category: 'framework', confidence: 0.9 } },
  { match: /alpine(\.min)?\.js|alpinejs/, rule: { name: 'Alpine.js', category: 'library', confidence: 0.9 } },
  { match: /htmx(\.min)?\.js/, rule: { name: 'htmx', category: 'library', confidence: 0.95 } },
  { match: /googletagmanager\.com\/gtm\.js/, rule: { name: 'Google Tag Manager', category: 'analytics', confidence: 0.98 } },
  { match: /googletagmanager\.com\/gtag\/js|google-analytics\.com/, rule: { name: 'Google Analytics', category: 'analytics', confidence: 0.98 } },
  { match: /connect\.facebook\.net/, rule: { name: 'Meta Pixel', category: 'analytics', confidence: 0.95 } },
  { match: /static\.hotjar\.com/, rule: { name: 'Hotjar', category: 'analytics', confidence: 0.98 } },
  { match: /cdn\.segment\.com/, rule: { name: 'Segment', category: 'analytics', confidence: 0.98 } },
  { match: /js\.hs-scripts\.com|js\.hubspot\.com/, rule: { name: 'HubSpot', category: 'analytics', confidence: 0.98 } },
  { match: /widget\.intercom\.io|js\.intercomcdn\.com/, rule: { name: 'Intercom', category: 'analytics', confidence: 0.98 } },
  { match: /cdn\.mxpnl\.com|mixpanel/, rule: { name: 'Mixpanel', category: 'analytics', confidence: 0.9 } },
  { match: /cdn\.amplitude\.com/, rule: { name: 'Amplitude', category: 'analytics', confidence: 0.95 } },
  { match: /plausible\.io\/js/, rule: { name: 'Plausible', category: 'analytics', confidence: 0.98 } },
  { match: /cdn\.usefathom\.com/, rule: { name: 'Fathom', category: 'analytics', confidence: 0.98 } },
  { match: /static\.cloudflareinsights\.com/, rule: { name: 'Cloudflare Web Analytics', category: 'analytics', confidence: 0.98 } },
  { match: /js\.sentry-cdn\.com|browser\.sentry-cdn\.com/, rule: { name: 'Sentry', category: 'analytics', confidence: 0.98 } },
  { match: /js\.stripe\.com/, rule: { name: 'Stripe', category: 'infra', confidence: 0.98 } },
  { match: /www\.paypal\.com\/sdk/, rule: { name: 'PayPal', category: 'infra', confidence: 0.98 } },
  { match: /www\.google\.com\/recaptcha|www\.gstatic\.com\/recaptcha/, rule: { name: 'reCAPTCHA', category: 'library', confidence: 0.98 } },
  { match: /challenges\.cloudflare\.com\/turnstile/, rule: { name: 'Cloudflare Turnstile', category: 'library', confidence: 0.98 } },
  { match: /hcaptcha\.com/, rule: { name: 'hCaptcha', category: 'library', confidence: 0.98 } },
  { match: /cdnjs\.cloudflare\.com/, rule: { name: 'cdnjs', category: 'cdn', confidence: 0.95 } },
  { match: /unpkg\.com/, rule: { name: 'unpkg', category: 'cdn', confidence: 0.95 } },
  { match: /cdn\.jsdelivr\.net/, rule: { name: 'jsDelivr', category: 'cdn', confidence: 0.95 } },
  { match: /fonts\.googleapis\.com|fonts\.gstatic\.com/, rule: { name: 'Google Fonts', category: 'cdn', confidence: 0.95 } },
  { match: /use\.typekit\.net/, rule: { name: 'Adobe Fonts (Typekit)', category: 'cdn', confidence: 0.95 } },
  { match: /kit\.fontawesome\.com|font-awesome/, rule: { name: 'Font Awesome', category: 'library', confidence: 0.9 } },
  { match: /cdn\.tailwindcss\.com/, rule: { name: 'Tailwind CSS (CDN)', category: 'library', confidence: 0.98 } },
  { match: /firebasejs|firebaseapp\.com|gstatic\.com\/firebasejs/, rule: { name: 'Firebase', category: 'infra', confidence: 0.95 } },
  { match: /\.supabase\.co/, rule: { name: 'Supabase', category: 'infra', confidence: 0.95 } },
  { match: /cloudfront\.net/, rule: { name: 'Amazon CloudFront', category: 'cdn', confidence: 0.9 } },
  { match: /\.akamaihd\.net|\.akamaized\.net/, rule: { name: 'Akamai', category: 'cdn', confidence: 0.9 } },
  { match: /cdn\.sanity\.io/, rule: { name: 'Sanity', category: 'cms', confidence: 0.95 } },
  { match: /images\.ctfassets\.net|cdn\.contentful\.com/, rule: { name: 'Contentful', category: 'cms', confidence: 0.95 } },
  { match: /\.prismic\.io/, rule: { name: 'Prismic', category: 'cms', confidence: 0.95 } },
  { match: /cdn\.builder\.io/, rule: { name: 'Builder.io', category: 'cms', confidence: 0.95 } },
  { match: /clarity\.ms/, rule: { name: 'Microsoft Clarity', category: 'analytics', confidence: 0.98 } },
  { match: /static\.klaviyo\.com/, rule: { name: 'Klaviyo', category: 'analytics', confidence: 0.98 } },
  { match: /cookiebot\.com|onetrust\.com|cookielaw\.org/, rule: { name: 'Cookie consent platform', category: 'library', confidence: 0.95 } },
];

const GLOBAL_RULES: Record<string, Rule> = {
  __NEXT_DATA__: { name: 'Next.js', category: 'framework', confidence: 0.98 },
  __NUXT__: { name: 'Nuxt', category: 'framework', confidence: 0.98 },
  __remixContext: { name: 'Remix', category: 'framework', confidence: 0.98 },
  __SVELTEKIT__: { name: 'SvelteKit', category: 'framework', confidence: 0.98 },
  ___gatsby: { name: 'Gatsby', category: 'framework', confidence: 0.98 },
  React: { name: 'React', category: 'framework', confidence: 0.9 },
  ReactDOM: { name: 'React', category: 'framework', confidence: 0.9 },
  'react-dom-markers': { name: 'React', category: 'framework', confidence: 0.8 },
  Vue: { name: 'Vue', category: 'framework', confidence: 0.9 },
  angular: { name: 'AngularJS', category: 'framework', confidence: 0.8 },
  ng: { name: 'Angular', category: 'framework', confidence: 0.6 },
  jQuery: { name: 'jQuery', category: 'library', confidence: 0.95 },
  Ember: { name: 'Ember.js', category: 'framework', confidence: 0.95 },
  Backbone: { name: 'Backbone.js', category: 'framework', confidence: 0.95 },
  Shopify: { name: 'Shopify', category: 'cms', confidence: 0.98 },
  wp: { name: 'WordPress', category: 'cms', confidence: 0.7 },
  Drupal: { name: 'Drupal', category: 'cms', confidence: 0.98 },
  Squarespace: { name: 'Squarespace', category: 'cms', confidence: 0.98 },
  Wix: { name: 'Wix', category: 'cms', confidence: 0.98 },
  webflow: { name: 'Webflow', category: 'cms', confidence: 0.95 },
  dataLayer: { name: 'Google Tag Manager', category: 'analytics', confidence: 0.8 },
  gtag: { name: 'Google Analytics', category: 'analytics', confidence: 0.9 },
  fbq: { name: 'Meta Pixel', category: 'analytics', confidence: 0.95 },
  hj: { name: 'Hotjar', category: 'analytics', confidence: 0.95 },
  Intercom: { name: 'Intercom', category: 'analytics', confidence: 0.95 },
  mixpanel: { name: 'Mixpanel', category: 'analytics', confidence: 0.95 },
  amplitude: { name: 'Amplitude', category: 'analytics', confidence: 0.95 },
  Sentry: { name: 'Sentry', category: 'analytics', confidence: 0.95 },
  Stripe: { name: 'Stripe', category: 'infra', confidence: 0.95 },
  firebase: { name: 'Firebase', category: 'infra', confidence: 0.95 },
  supabase: { name: 'Supabase', category: 'infra', confidence: 0.9 },
};

const GENERATOR_RULES: { match: RegExp; rule: Rule; versionFrom?: RegExp }[] = [
  { match: /wordpress/i, rule: { name: 'WordPress', category: 'cms', confidence: 0.98 }, versionFrom: /wordpress\s*([\d.]+)/i },
  { match: /drupal/i, rule: { name: 'Drupal', category: 'cms', confidence: 0.98 }, versionFrom: /drupal\s*([\d.]+)/i },
  { match: /joomla/i, rule: { name: 'Joomla', category: 'cms', confidence: 0.98 } },
  { match: /hugo/i, rule: { name: 'Hugo', category: 'framework', confidence: 0.98 }, versionFrom: /hugo\s*([\d.]+)/i },
  { match: /gatsby/i, rule: { name: 'Gatsby', category: 'framework', confidence: 0.98 }, versionFrom: /gatsby\s*([\d.]+)/i },
  { match: /jekyll/i, rule: { name: 'Jekyll', category: 'framework', confidence: 0.98 }, versionFrom: /jekyll\s*v?([\d.]+)/i },
  { match: /astro/i, rule: { name: 'Astro', category: 'framework', confidence: 0.98 }, versionFrom: /astro\s*v?([\d.]+)/i },
  { match: /docusaurus/i, rule: { name: 'Docusaurus', category: 'framework', confidence: 0.98 }, versionFrom: /v([\d.]+)/i },
  { match: /vitepress/i, rule: { name: 'VitePress', category: 'framework', confidence: 0.98 } },
  { match: /mkdocs/i, rule: { name: 'MkDocs', category: 'framework', confidence: 0.98 }, versionFrom: /mkdocs-([\d.]+)/i },
  { match: /sphinx/i, rule: { name: 'Sphinx', category: 'framework', confidence: 0.95 } },
  { match: /ghost/i, rule: { name: 'Ghost', category: 'cms', confidence: 0.98 }, versionFrom: /ghost\s*([\d.]+)/i },
  { match: /shopify/i, rule: { name: 'Shopify', category: 'cms', confidence: 0.98 } },
  { match: /wix\.com/i, rule: { name: 'Wix', category: 'cms', confidence: 0.98 } },
  { match: /squarespace/i, rule: { name: 'Squarespace', category: 'cms', confidence: 0.98 } },
  { match: /webflow/i, rule: { name: 'Webflow', category: 'cms', confidence: 0.98 } },
  { match: /eleventy|11ty/i, rule: { name: 'Eleventy', category: 'framework', confidence: 0.98 } },
  { match: /nuxt/i, rule: { name: 'Nuxt', category: 'framework', confidence: 0.98 } },
  { match: /gridsome/i, rule: { name: 'Gridsome', category: 'framework', confidence: 0.98 } },
  { match: /hubspot/i, rule: { name: 'HubSpot CMS', category: 'cms', confidence: 0.98 } },
  { match: /typo3/i, rule: { name: 'TYPO3', category: 'cms', confidence: 0.98 } },
  { match: /magento/i, rule: { name: 'Magento', category: 'cms', confidence: 0.98 } },
  { match: /woocommerce/i, rule: { name: 'WooCommerce', category: 'cms', confidence: 0.98 } },
];

/**
 * Fingerprints technologies across all crawled pages.
 */
export function detectWebTech(pages: CrawledPage[]): TechSignal[] {
  const signals: TechSignal[] = [];

  for (const page of pages) {
    const where = shortUrl(page.finalUrl || page.url);

    for (const r of HEADER_RULES) {
      const value = page.headers[r.header];
      if (value === undefined) continue;
      if (r.match && !r.match.test(value)) continue;
      const version = r.versionFrom ? value.match(r.versionFrom)?.slice(1).find(Boolean) : undefined;
      signals.push({ ...r.rule, version, evidence: `${r.header}: ${value.slice(0, 80)} (${where})` });
    }

    for (const c of page.cookies) {
      for (const r of COOKIE_RULES) {
        if (r.match.test(c.name)) signals.push({ ...r.rule, evidence: `cookie ${c.name} (${where})` });
      }
    }

    const generator = page.meta.generator;
    if (generator) {
      let matched = false;
      for (const r of GENERATOR_RULES) {
        if (!r.match.test(generator)) continue;
        matched = true;
        const version = r.versionFrom ? generator.match(r.versionFrom)?.[1] : undefined;
        signals.push({ ...r.rule, version, evidence: `meta generator "${generator}" (${where})` });
      }
      if (!matched) signals.push({ name: generator.slice(0, 60), category: 'other', evidence: `meta generator (${where})`, confidence: 0.8 });
    }

    for (const url of [...page.scripts, ...page.stylesheets]) {
      for (const r of URL_RULES) {
        if (!r.match.test(url)) continue;
        const version = r.versionFrom ? url.match(r.versionFrom)?.slice(1).find(Boolean) : undefined;
        signals.push({ ...r.rule, version, evidence: `${shortUrl(url)} (${where})` });
      }
    }

    for (const g of page.globals) {
      if (g.startsWith('angular@')) {
        signals.push({ name: 'Angular', category: 'framework', version: g.split('@')[1], evidence: `ng-version attribute (${where})`, confidence: 0.98 });
        continue;
      }
      const rule = GLOBAL_RULES[g];
      if (rule) signals.push({ ...rule, evidence: `window.${g} present (${where})` });
    }

    // HTML markers that survive the reduction step.
    if (/data-v-[0-9a-f]{8}/.test(page.html)) signals.push({ name: 'Vue', category: 'framework', evidence: `scoped data-v- attributes (${where})`, confidence: 0.85 });
    if (/_ngcontent-|_nghost-/.test(page.html)) signals.push({ name: 'Angular', category: 'framework', evidence: `_ngcontent attributes (${where})`, confidence: 0.9 });
    if (/class="[^"]*\b(svelte-[0-9a-z]{5,})/.test(page.html)) signals.push({ name: 'Svelte', category: 'framework', evidence: `svelte- class hashes (${where})`, confidence: 0.9 });
    if (/hx-(get|post|trigger|target)=/.test(page.html)) signals.push({ name: 'htmx', category: 'library', evidence: `hx- attributes (${where})`, confidence: 0.95 });
    if (/x-data=|x-on:|@click=/.test(page.html)) signals.push({ name: 'Alpine.js', category: 'library', evidence: `x-data attributes (${where})`, confidence: 0.7 });
    if (/data-turbo|data-controller=/.test(page.html)) signals.push({ name: 'Hotwire (Turbo/Stimulus)', category: 'library', evidence: `data-turbo/data-controller (${where})`, confidence: 0.85 });
    if (/wire:click|wire:model|livewire/.test(page.html)) signals.push({ name: 'Laravel Livewire', category: 'framework', evidence: `wire: attributes (${where})`, confidence: 0.9 });
    if (/class="[^"]*\b(flex|grid|px-\d|py-\d|text-(sm|lg|xl)|bg-[a-z]+-\d{3})\b[^"]*\b(flex|grid|px-\d|py-\d|mt-\d|mb-\d|rounded(-\w+)?)\b/.test(page.html)) {
      signals.push({ name: 'Tailwind CSS', category: 'library', evidence: `utility class patterns (${where})`, confidence: 0.6 });
    }
    if (/class="[^"]*\b(container|row|col-(xs|sm|md|lg|xl)-\d+|btn btn-)/.test(page.html)) signals.push({ name: 'Bootstrap', category: 'library', evidence: `grid/btn classes (${where})`, confidence: 0.6 });
    if (/<link[^>]+rel="?manifest"?/i.test(page.html)) signals.push({ name: 'Web App Manifest (PWA)', category: 'other', evidence: `link rel=manifest (${where})`, confidence: 0.8 });
    if (/serviceWorker\.register/.test(page.inlineScriptSample)) signals.push({ name: 'Service Worker (PWA)', category: 'other', evidence: `inline registration (${where})`, confidence: 0.9 });
  }

  // Security header presence is reported as "technology" so it lands in the inventory the LLM sees.
  const first = pages.find((p) => p.status && p.status < 400) ?? pages[0];
  if (first) {
    for (const h of ['content-security-policy', 'strict-transport-security', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy']) {
      if (first.headers[h]) signals.push({ name: `Security header: ${h}`, category: 'other', evidence: `${h}: ${first.headers[h]!.slice(0, 80)}`, confidence: 1 });
    }
  }

  return dedupeSignals(signals);
}

function shortUrl(u: string): string {
  try {
    const p = new URL(u);
    const path = p.pathname.length > 40 ? `${p.pathname.slice(0, 37)}...` : p.pathname;
    return `${p.host}${path}`;
  } catch {
    return u.slice(0, 60);
  }
}
