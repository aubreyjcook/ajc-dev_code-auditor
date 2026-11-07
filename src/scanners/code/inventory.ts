/**
 * @module scanners/code/inventory
 *
 * Deterministic technology detection for codebases. Reads well-known
 * manifests and configuration files and produces {@link TechSignal}s with
 * concrete evidence. The LLM later receives this list as ground truth so its
 * "technology summary" is anchored in facts instead of guesses.
 */

import path from 'node:path';
import type { ScanItem, TechSignal, TechCategory } from '../types.js';

/** Known npm packages and what they indicate. */
const NPM_PACKAGE_MAP: Record<string, { name: string; category: TechCategory }> = {
  react: { name: 'React', category: 'framework' },
  'react-dom': { name: 'React DOM', category: 'library' },
  next: { name: 'Next.js', category: 'framework' },
  vue: { name: 'Vue', category: 'framework' },
  nuxt: { name: 'Nuxt', category: 'framework' },
  svelte: { name: 'Svelte', category: 'framework' },
  '@sveltejs/kit': { name: 'SvelteKit', category: 'framework' },
  '@angular/core': { name: 'Angular', category: 'framework' },
  astro: { name: 'Astro', category: 'framework' },
  'solid-js': { name: 'SolidJS', category: 'framework' },
  express: { name: 'Express', category: 'framework' },
  fastify: { name: 'Fastify', category: 'framework' },
  koa: { name: 'Koa', category: 'framework' },
  hono: { name: 'Hono', category: 'framework' },
  '@nestjs/core': { name: 'NestJS', category: 'framework' },
  'remix': { name: 'Remix', category: 'framework' },
  '@remix-run/node': { name: 'Remix', category: 'framework' },
  electron: { name: 'Electron', category: 'runtime' },
  'react-native': { name: 'React Native', category: 'framework' },
  expo: { name: 'Expo', category: 'framework' },
  typescript: { name: 'TypeScript', category: 'language' },
  vite: { name: 'Vite', category: 'build' },
  webpack: { name: 'webpack', category: 'build' },
  esbuild: { name: 'esbuild', category: 'build' },
  rollup: { name: 'Rollup', category: 'build' },
  turbo: { name: 'Turborepo', category: 'build' },
  nx: { name: 'Nx', category: 'build' },
  jest: { name: 'Jest', category: 'test' },
  vitest: { name: 'Vitest', category: 'test' },
  mocha: { name: 'Mocha', category: 'test' },
  cypress: { name: 'Cypress', category: 'test' },
  playwright: { name: 'Playwright', category: 'test' },
  '@playwright/test': { name: 'Playwright', category: 'test' },
  eslint: { name: 'ESLint', category: 'build' },
  prettier: { name: 'Prettier', category: 'build' },
  tailwindcss: { name: 'Tailwind CSS', category: 'library' },
  'styled-components': { name: 'styled-components', category: 'library' },
  '@emotion/react': { name: 'Emotion', category: 'library' },
  prisma: { name: 'Prisma', category: 'database' },
  '@prisma/client': { name: 'Prisma', category: 'database' },
  mongoose: { name: 'Mongoose (MongoDB)', category: 'database' },
  mongodb: { name: 'MongoDB driver', category: 'database' },
  pg: { name: 'PostgreSQL (pg)', category: 'database' },
  mysql2: { name: 'MySQL', category: 'database' },
  sequelize: { name: 'Sequelize', category: 'database' },
  typeorm: { name: 'TypeORM', category: 'database' },
  'drizzle-orm': { name: 'Drizzle ORM', category: 'database' },
  knex: { name: 'Knex', category: 'database' },
  redis: { name: 'Redis', category: 'database' },
  ioredis: { name: 'Redis (ioredis)', category: 'database' },
  '@supabase/supabase-js': { name: 'Supabase', category: 'infra' },
  firebase: { name: 'Firebase', category: 'infra' },
  'aws-sdk': { name: 'AWS SDK v2', category: 'infra' },
  '@aws-sdk/client-s3': { name: 'AWS SDK v3', category: 'infra' },
  graphql: { name: 'GraphQL', category: 'library' },
  '@apollo/server': { name: 'Apollo Server', category: 'framework' },
  '@apollo/client': { name: 'Apollo Client', category: 'library' },
  axios: { name: 'Axios', category: 'library' },
  zod: { name: 'Zod', category: 'library' },
  passport: { name: 'Passport', category: 'library' },
  jsonwebtoken: { name: 'jsonwebtoken (JWT)', category: 'library' },
  bcrypt: { name: 'bcrypt', category: 'library' },
  'next-auth': { name: 'NextAuth.js', category: 'library' },
  stripe: { name: 'Stripe', category: 'infra' },
  socket: { name: 'Socket.IO', category: 'library' },
  'socket.io': { name: 'Socket.IO', category: 'library' },
  lodash: { name: 'Lodash', category: 'library' },
  moment: { name: 'Moment.js', category: 'library' },
  dayjs: { name: 'Day.js', category: 'library' },
  'date-fns': { name: 'date-fns', category: 'library' },
  openai: { name: 'OpenAI SDK', category: 'library' },
  '@anthropic-ai/sdk': { name: 'Anthropic SDK', category: 'library' },
  langchain: { name: 'LangChain', category: 'library' },
};

/** Known Python packages. */
const PY_PACKAGE_MAP: Record<string, { name: string; category: TechCategory }> = {
  django: { name: 'Django', category: 'framework' },
  flask: { name: 'Flask', category: 'framework' },
  fastapi: { name: 'FastAPI', category: 'framework' },
  starlette: { name: 'Starlette', category: 'framework' },
  tornado: { name: 'Tornado', category: 'framework' },
  sqlalchemy: { name: 'SQLAlchemy', category: 'database' },
  psycopg2: { name: 'PostgreSQL (psycopg2)', category: 'database' },
  'psycopg2-binary': { name: 'PostgreSQL (psycopg2)', category: 'database' },
  pymongo: { name: 'MongoDB (pymongo)', category: 'database' },
  redis: { name: 'Redis', category: 'database' },
  celery: { name: 'Celery', category: 'infra' },
  pytest: { name: 'pytest', category: 'test' },
  numpy: { name: 'NumPy', category: 'library' },
  pandas: { name: 'pandas', category: 'library' },
  torch: { name: 'PyTorch', category: 'library' },
  tensorflow: { name: 'TensorFlow', category: 'library' },
  scikit_learn: { name: 'scikit-learn', category: 'library' },
  'scikit-learn': { name: 'scikit-learn', category: 'library' },
  requests: { name: 'Requests', category: 'library' },
  httpx: { name: 'HTTPX', category: 'library' },
  pydantic: { name: 'Pydantic', category: 'library' },
  boto3: { name: 'AWS SDK (boto3)', category: 'infra' },
  uvicorn: { name: 'Uvicorn', category: 'server' },
  gunicorn: { name: 'Gunicorn', category: 'server' },
  openai: { name: 'OpenAI SDK', category: 'library' },
  langchain: { name: 'LangChain', category: 'library' },
};

/**
 * Detects technologies from the collected files.
 *
 * @param items - Files collected by `collectFiles`.
 * @returns De-duplicated signals, highest confidence first.
 */
export function detectCodeTech(items: ScanItem[]): TechSignal[] {
  const signals: TechSignal[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));

  // --- Language histogram -------------------------------------------------
  const langCounts = new Map<string, number>();
  for (const item of items) {
    if (!item.language) continue;
    langCounts.set(item.language, (langCounts.get(item.language) ?? 0) + 1);
  }
  const codeLangs = ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'php', 'ruby', 'swift', 'cpp', 'c', 'dart', 'elixir', 'scala'];
  for (const [lang, count] of [...langCounts.entries()].sort((a, b) => b[1] - a[1])) {
    if (!codeLangs.includes(lang)) continue;
    signals.push({ name: titleCase(lang), category: 'language', evidence: `${count} ${lang} file(s)`, confidence: Math.min(1, 0.5 + count / 20) });
  }

  // --- package.json (any depth; monorepos have many) ----------------------
  for (const item of items) {
    if (path.posix.basename(item.id) !== 'package.json') continue;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(item.content) as Record<string, unknown>;
    } catch {
      continue;
    }
    signals.push({ name: 'Node.js', category: 'runtime', evidence: item.id, confidence: 0.9 });
    const engines = pkg.engines as Record<string, string> | undefined;
    if (engines?.node) signals.push({ name: 'Node.js', category: 'runtime', version: engines.node, evidence: `${item.id} engines.node`, confidence: 0.95 });
    if (typeof pkg.packageManager === 'string') {
      const [pm, ver] = pkg.packageManager.split('@');
      signals.push({ name: pm!, category: 'build', version: ver, evidence: `${item.id} packageManager`, confidence: 0.95 });
    }
    if (pkg.type === 'module') signals.push({ name: 'ES Modules', category: 'other', evidence: `${item.id} "type": "module"`, confidence: 0.9 });
    const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object), ...(pkg.peerDependencies as object) } as Record<string, string>;
    for (const [dep, version] of Object.entries(deps)) {
      const known = NPM_PACKAGE_MAP[dep];
      if (known) signals.push({ ...known, version, evidence: `${item.id} depends on ${dep}`, confidence: 0.9 });
    }
    if (Array.isArray(pkg.workspaces)) signals.push({ name: 'npm/yarn workspaces (monorepo)', category: 'build', evidence: `${item.id} workspaces`, confidence: 0.9 });
  }

  // --- Package manager hints ----------------------------------------------
  // Lockfiles are excluded by the collector (too large, no logic), so we rely
  // on the small config files that accompany each package manager instead.
  if (byId.has('pnpm-workspace.yaml')) signals.push({ name: 'pnpm workspaces', category: 'build', evidence: 'pnpm-workspace.yaml', confidence: 0.95 });
  if (byId.has('.npmrc')) signals.push({ name: 'npm config (.npmrc)', category: 'build', evidence: '.npmrc', confidence: 0.6 });
  if (byId.has('.yarnrc.yml') || byId.has('.yarnrc')) signals.push({ name: 'Yarn', category: 'build', evidence: '.yarnrc', confidence: 0.9 });
  if (byId.has('bunfig.toml')) signals.push({ name: 'Bun', category: 'runtime', evidence: 'bunfig.toml', confidence: 0.9 });

  // --- Python ---------------------------------------------------------------
  for (const item of items) {
    const base = path.posix.basename(item.id).toLowerCase();
    if (base === 'requirements.txt' || base.startsWith('requirements-') || base === 'pyproject.toml' || base === 'pipfile' || base === 'setup.py') {
      signals.push({ name: 'Python', category: 'language', evidence: item.id, confidence: 0.95 });
      const lower = item.content.toLowerCase();
      for (const [pkg, known] of Object.entries(PY_PACKAGE_MAP)) {
        const re = new RegExp(`(^|["'\\s\\[])${escapeRe(pkg)}\\s*([=<>!~\\[]|$)`, 'm');
        if (re.test(lower)) signals.push({ ...known, evidence: `${item.id} lists ${pkg}`, confidence: 0.85 });
      }
      if (base === 'pyproject.toml') {
        if (/\[tool\.poetry\]/.test(item.content)) signals.push({ name: 'Poetry', category: 'build', evidence: item.id, confidence: 0.9 });
        if (/\[tool\.uv\]|uv\.lock/.test(item.content)) signals.push({ name: 'uv', category: 'build', evidence: item.id, confidence: 0.7 });
        const pyReq = item.content.match(/requires-python\s*=\s*"([^"]+)"/);
        if (pyReq) signals.push({ name: 'Python', category: 'language', version: pyReq[1], evidence: `${item.id} requires-python`, confidence: 0.95 });
      }
    }
  }

  // --- Other ecosystems -----------------------------------------------------
  const goMod = findByBasename(items, 'go.mod');
  if (goMod) {
    const goVer = goMod.content.match(/^go\s+(\S+)/m)?.[1];
    signals.push({ name: 'Go', category: 'language', version: goVer, evidence: goMod.id, confidence: 0.95 });
    for (const [mod, name] of [
      ['github.com/gin-gonic/gin', 'Gin'],
      ['github.com/labstack/echo', 'Echo'],
      ['github.com/gofiber/fiber', 'Fiber'],
      ['github.com/go-chi/chi', 'chi'],
      ['gorm.io/gorm', 'GORM'],
      ['github.com/spf13/cobra', 'Cobra'],
    ] as const) {
      if (goMod.content.includes(mod)) signals.push({ name, category: 'framework', evidence: `${goMod.id} requires ${mod}`, confidence: 0.9 });
    }
  }
  const cargo = findByBasename(items, 'Cargo.toml');
  if (cargo) {
    signals.push({ name: 'Rust', category: 'language', evidence: cargo.id, confidence: 0.95 });
    for (const [crate, name] of [
      ['actix-web', 'Actix Web'],
      ['axum', 'Axum'],
      ['rocket', 'Rocket'],
      ['tokio', 'Tokio'],
      ['serde', 'Serde'],
      ['sqlx', 'SQLx'],
      ['diesel', 'Diesel'],
    ] as const) {
      if (new RegExp(`^${escapeRe(crate)}\\s*=`, 'm').test(cargo.content)) signals.push({ name, category: crate === 'tokio' || crate === 'serde' ? 'library' : 'framework', evidence: `${cargo.id} depends on ${crate}`, confidence: 0.9 });
    }
  }
  const pom = findByBasename(items, 'pom.xml');
  if (pom) {
    signals.push({ name: 'Java', category: 'language', evidence: pom.id, confidence: 0.9 });
    signals.push({ name: 'Maven', category: 'build', evidence: pom.id, confidence: 0.95 });
    if (/spring-boot/.test(pom.content)) signals.push({ name: 'Spring Boot', category: 'framework', evidence: pom.id, confidence: 0.9 });
  }
  const gradle = findByBasename(items, 'build.gradle') ?? findByBasename(items, 'build.gradle.kts');
  if (gradle) {
    signals.push({ name: 'Gradle', category: 'build', evidence: gradle.id, confidence: 0.95 });
    if (/kotlin/.test(gradle.content)) signals.push({ name: 'Kotlin', category: 'language', evidence: gradle.id, confidence: 0.8 });
    if (/spring-boot/.test(gradle.content)) signals.push({ name: 'Spring Boot', category: 'framework', evidence: gradle.id, confidence: 0.9 });
    if (/com\.android/.test(gradle.content)) signals.push({ name: 'Android', category: 'framework', evidence: gradle.id, confidence: 0.9 });
  }
  const gemfile = findByBasename(items, 'Gemfile');
  if (gemfile) {
    signals.push({ name: 'Ruby', category: 'language', evidence: gemfile.id, confidence: 0.95 });
    signals.push({ name: 'Bundler', category: 'build', evidence: gemfile.id, confidence: 0.9 });
    if (/gem ['"]rails['"]/.test(gemfile.content)) signals.push({ name: 'Ruby on Rails', category: 'framework', evidence: gemfile.id, confidence: 0.95 });
    if (/gem ['"]sinatra['"]/.test(gemfile.content)) signals.push({ name: 'Sinatra', category: 'framework', evidence: gemfile.id, confidence: 0.9 });
  }
  const composer = findByBasename(items, 'composer.json');
  if (composer) {
    signals.push({ name: 'PHP', category: 'language', evidence: composer.id, confidence: 0.95 });
    signals.push({ name: 'Composer', category: 'build', evidence: composer.id, confidence: 0.95 });
    if (/laravel\/framework/.test(composer.content)) signals.push({ name: 'Laravel', category: 'framework', evidence: composer.id, confidence: 0.95 });
    if (/symfony\//.test(composer.content)) signals.push({ name: 'Symfony', category: 'framework', evidence: composer.id, confidence: 0.85 });
  }
  const csproj = items.find((i) => /\.csproj$/.test(i.id));
  if (csproj) {
    const tfm = csproj.content.match(/<TargetFrameworks?>([^<]+)</)?.[1];
    signals.push({ name: '.NET / C#', category: 'language', version: tfm, evidence: csproj.id, confidence: 0.95 });
    if (/Microsoft\.AspNetCore/.test(csproj.content) || /Sdk="Microsoft\.NET\.Sdk\.Web"/.test(csproj.content)) signals.push({ name: 'ASP.NET Core', category: 'framework', evidence: csproj.id, confidence: 0.9 });
  }
  const pubspec = findByBasename(items, 'pubspec.yaml');
  if (pubspec) {
    signals.push({ name: 'Dart', category: 'language', evidence: pubspec.id, confidence: 0.95 });
    if (/flutter:/.test(pubspec.content)) signals.push({ name: 'Flutter', category: 'framework', evidence: pubspec.id, confidence: 0.95 });
  }
  const mix = findByBasename(items, 'mix.exs');
  if (mix) {
    signals.push({ name: 'Elixir', category: 'language', evidence: mix.id, confidence: 0.95 });
    if (/:phoenix/.test(mix.content)) signals.push({ name: 'Phoenix', category: 'framework', evidence: mix.id, confidence: 0.95 });
  }

  // --- Infra / CI -------------------------------------------------------------
  for (const item of items) {
    const base = path.posix.basename(item.id).toLowerCase();
    if (base === 'dockerfile' || base.startsWith('dockerfile.')) {
      const from = item.content.match(/^FROM\s+(\S+)/m)?.[1];
      signals.push({ name: 'Docker', category: 'infra', version: from, evidence: `${item.id}${from ? ` FROM ${from}` : ''}`, confidence: 0.95 });
    }
    if (/^docker-compose(\..*)?\.ya?ml$/.test(base) || base === 'compose.yaml' || base === 'compose.yml') {
      signals.push({ name: 'Docker Compose', category: 'infra', evidence: item.id, confidence: 0.95 });
      for (const [img, name] of [
        ['postgres', 'PostgreSQL'],
        ['mysql', 'MySQL'],
        ['mariadb', 'MariaDB'],
        ['mongo', 'MongoDB'],
        ['redis', 'Redis'],
        ['rabbitmq', 'RabbitMQ'],
        ['elasticsearch', 'Elasticsearch'],
        ['nginx', 'nginx'],
      ] as const) {
        if (new RegExp(`image:\\s*["']?${img}`, 'i').test(item.content)) signals.push({ name, category: img === 'nginx' ? 'server' : img === 'rabbitmq' ? 'infra' : 'database', evidence: `${item.id} image ${img}`, confidence: 0.9 });
      }
    }
    if (item.id.startsWith('.github/workflows/')) signals.push({ name: 'GitHub Actions', category: 'ci', evidence: item.id, confidence: 0.95 });
    if (base === '.gitlab-ci.yml') signals.push({ name: 'GitLab CI', category: 'ci', evidence: item.id, confidence: 0.95 });
    if (item.id.startsWith('.circleci/')) signals.push({ name: 'CircleCI', category: 'ci', evidence: item.id, confidence: 0.95 });
    if (base === 'azure-pipelines.yml') signals.push({ name: 'Azure Pipelines', category: 'ci', evidence: item.id, confidence: 0.95 });
    if (base === 'jenkinsfile') signals.push({ name: 'Jenkins', category: 'ci', evidence: item.id, confidence: 0.95 });
    if (base === 'bitbucket-pipelines.yml') signals.push({ name: 'Bitbucket Pipelines', category: 'ci', evidence: item.id, confidence: 0.95 });
    if (/\.tf$/.test(base)) signals.push({ name: 'Terraform', category: 'infra', evidence: item.id, confidence: 0.95 });
    if (base === 'serverless.yml' || base === 'serverless.yaml') signals.push({ name: 'Serverless Framework', category: 'infra', evidence: item.id, confidence: 0.95 });
    if (base === 'vercel.json') signals.push({ name: 'Vercel', category: 'infra', evidence: item.id, confidence: 0.9 });
    if (base === 'netlify.toml') signals.push({ name: 'Netlify', category: 'infra', evidence: item.id, confidence: 0.9 });
    if (base === 'fly.toml') signals.push({ name: 'Fly.io', category: 'infra', evidence: item.id, confidence: 0.9 });
    if (base === 'render.yaml') signals.push({ name: 'Render', category: 'infra', evidence: item.id, confidence: 0.9 });
    if (base === 'app.yaml' && /runtime:/.test(item.content)) signals.push({ name: 'Google App Engine', category: 'infra', evidence: item.id, confidence: 0.8 });
    if (/^(helm|charts)\//.test(item.id) || base === 'chart.yaml') signals.push({ name: 'Helm', category: 'infra', evidence: item.id, confidence: 0.85 });
    if (/kind:\s*(Deployment|Service|Ingress|StatefulSet)/.test(item.content) && /apiVersion:/.test(item.content)) signals.push({ name: 'Kubernetes', category: 'infra', evidence: item.id, confidence: 0.85 });
    if (base === 'schema.prisma') signals.push({ name: 'Prisma', category: 'database', evidence: item.id, confidence: 0.95 });
  }

  return dedupeSignals(signals);
}

function findByBasename(items: ScanItem[], base: string): ScanItem | undefined {
  // Prefer the shallowest match (root manifest over nested packages).
  return items
    .filter((i) => path.posix.basename(i.id).toLowerCase() === base.toLowerCase())
    .sort((a, b) => a.id.split('/').length - b.id.split('/').length)[0];
}

/** Keeps one signal per (name, category), merging versions and evidence. */
export function dedupeSignals(signals: TechSignal[]): TechSignal[] {
  const map = new Map<string, TechSignal>();
  for (const s of signals) {
    const key = `${s.name.toLowerCase()}|${s.category}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...s });
      continue;
    }
    existing.confidence = Math.max(existing.confidence, s.confidence);
    if (!existing.version && s.version) existing.version = s.version;
    if (!existing.evidence.includes(s.evidence)) {
      const merged = `${existing.evidence}; ${s.evidence}`;
      existing.evidence = merged.length > 200 ? `${merged.slice(0, 197)}...` : merged;
    }
  }
  const order: TechCategory[] = ['language', 'runtime', 'framework', 'library', 'database', 'build', 'test', 'ci', 'infra', 'server', 'cms', 'analytics', 'cdn', 'other'];
  return [...map.values()].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || b.confidence - a.confidence || a.name.localeCompare(b.name));
}

function titleCase(s: string): string {
  const special: Record<string, string> = { typescript: 'TypeScript', javascript: 'JavaScript', csharp: 'C#', cpp: 'C++', php: 'PHP' };
  return special[s] ?? s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
