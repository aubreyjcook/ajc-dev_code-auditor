# Architecture

This document is a module-by-module walkthrough of the auditor. For how to run it, see the [README](../README.md). For every config field, see [CONFIGURATION.md](CONFIGURATION.md). For adapter internals, see [PROVIDERS.md](PROVIDERS.md).

## Design goals

- **Provider-agnostic.** The rest of the pipeline talks to a `LlmProvider` interface. Adding a new host is a new adapter plus a preset, not a change to scanning or reporting.
- **Free-tier first.** Default model, RPM caps, concurrency of 1, conservative token budgets, and an automatic fallback chain exist so a run can complete without a paid account.
- **Deterministic facts, LLM judgement.** Technology inventory and ownership signals are extracted by scanners without the model. The model interprets and narrates; it does not invent the inventory.
- **Always a complete report.** Failed batches mark a category `partial`. A failed synthesis pass falls back to a deterministic narrative. Truncated JSON is repaired when possible.
- **Library and CLI.** `runAudit()` is the single orchestration function; `cli.ts` is a thin Commander wrapper around it.

## High-level data flow

```
CLI / library caller
        │
        ▼
  loadConfig()          defaults < env < auditor.config.json < CLI
        │
        ▼
  runAudit({ kind, source, config })
        │
        ├─ scanCode() or scanWeb()  ──►  ScanResult
        │                                     │ items[], technology[], ownership[], gitAuthors?, stats
        │
        ├─ createProviderChain()    ──►  FallbackProvider wrapping 1..N adapters
        │
        ├─ analyze()                ──►  raw findings + category statuses + usage
        │       │
        │       ├─ chunkItems() / sampleItems()
        │       ├─ per-category prompt builders
        │       ├─ provider.complete()  (retry + RPM throttle inside the adapter)
        │       ├─ extractJson() + zod  (tolerant parse)
        │       └─ UsageTracker
        │
        ├─ synthesize()             ──►  narrative + merged findings with PREFIX-NNN ids
        │
        └─ writeReports()           ──►  report.md, report.json, terminal string
```

The `AuditReport` object (`src/report/types.ts`, `schemaVersion: 1`) is the single source of truth. Markdown and terminal renderers are pure functions over it, so a consumer of `report.json` can regenerate the human-readable views.

## Directory map

```
src/
  cli.ts                 Commander program: code / web / providers / categories
  audit.ts               runAudit() + toolInfo()
  index.ts               public library exports
  config/
    schema.ts            Zod schemas, PROVIDER_IDS, CATEGORY_IDS, DEFAULT_CONFIG
    load.ts              layered merge, AUDITOR_* env, ConfigError
  llm/
    provider.ts          LlmProvider, LlmRequest, LlmResponse, LlmError, classifyHttpError
    presets.ts           static knowledge per provider (URL, env var, default model, RPM)
    factory.ts           createProvider / createProviderChain
    fallback.ts          FallbackProvider: advances on fallback-eligible errors
    retry.ts             withRetry, honours Retry-After
    throttle.ts          sliding-window RateLimiter
    http.ts              postJson / getJson with timeout
    json.ts              extractJson + truncated-output repair
    tokens.ts            approximate token count
    gemini.ts            native generateContent adapter
    openai-compatible.ts chat/completions adapter (Groq, OpenRouter, Mistral, Ollama, OpenAI, generic)
    anthropic.ts         Messages API adapter (JSON-mode prefill "{")
    mock.ts              deterministic offline adapter
  scanners/
    types.ts             ScanItem, ScanResult, TechSignal, OwnershipSignal, ...
    code/                collect, git, inventory, ownership, index (scanCode)
    web/                 crawler, axe, inventory, ownership, index (scanWeb)
  analysis/
    categories.ts        CATEGORIES registry (idPrefix, appliesTo, perBatch, prompt)
    chunker.ts           pack items into token-budgeted batches; sampleItems
    schema.ts            parseAnalysisResponse / parseSynthesisResponse / toFinding
    analyzer.ts          analyze(): drives categories × batches
    synthesize.ts        heuristic dedupe, PREFIX-NNN ids, LLM or deterministic narrative
    usage.ts             UsageTracker
    prompts/             one builder per category + shared JSON contract + synthesis
  report/
    types.ts             AuditReport, Finding, Narrative, UsageSummary
    markdown.ts          renderMarkdown
    json.ts              renderJson
    terminal.ts          renderTerminal
    write.ts             writeReports → timestamped folder
  util/                  logger, fs helpers, concurrency (mapLimit, sleep, withTimeout)
```

## Scanning

### Code (`src/scanners/code/`)

`scanCode({ source, config, cwd })`:

1. If `source` looks like a git URL (`isGitUrl`), clone it shallowly to a temp directory (`cloneToTemp`) and remember to delete it. Credentials in the URL are redacted (`redactCredentials`) before they appear in the report.
2. `collectFiles` walks the tree with `fast-glob`, applying:
   - built-in ignores (`node_modules`, `dist`, `build`, `.git`, lockfiles, minified assets, images, archives, coverage, ...),
   - root and nested `.gitignore` via the `ignore` package,
   - `code.exclude` / `code.include` globs,
   - binary sniff (`looksBinary`),
   - `maxFileBytes`.
3. Remaining files are ranked (`priorityScore`): dependency manifests > infra/CI/config > entry points > application source > tests > docs. The lowest-ranked files are dropped when `maxFiles` is exceeded; they are recorded as skipped with reason `maxFiles`.
4. Each kept file becomes a `ScanItem` with `id` (posix relative path), `kind: 'file'`, language, size, and content.
5. `detectCodeTech` inspects manifests, Dockerfiles, CI configs, lockfile names and import patterns to produce `TechSignal[]`.
6. `detectCodeOwnership` extracts copyright lines (year or © required, so prose mentioning the word is ignored), LICENSE holders, `@author` tags, CODEOWNERS, package.json author/repository, git remote org, and git author statistics (`readRepoInfo`).

### Web (`src/scanners/web/`)

`scanWeb({ url, config })`:

1. Launch Playwright Chromium (`headless` / `userAgent` / `timeoutMs` from config).
2. `crawlSite` does a same-origin BFS from the start URL up to `maxPages` and `maxDepth`. Each page yields a `CrawledPage`: URL, status, headers, cookies, HTML, console errors, failed requests, outbound hosts, extracted same-origin links.
3. Optionally `runAxe` (`@axe-core/playwright`) on the page; violations are summarised (`formatAxeSummary`) and later injected into the accessibility prompt.
4. `pageToItem` / `buildPageDigest` turn each page into a compact text `ScanItem` (`kind: 'page'`) the model can read: title, headings, landmarks, forms, scripts, meta, notable headers, cookies, console errors, axe summary.
5. `detectWebTech` fingerprints from `Server`/`X-Powered-By`, generator meta, script URLs (jQuery, React, GA/GTM, ...), cookie names, and JS globals.
6. `detectWebOwnership` plus `fetchWellKnown` look at footer copyright, `<meta name="author">`, JSON-LD Organization/publisher, `mailto:` links, `/.well-known/security.txt`, `/humans.txt`, `/robots.txt`.

The crawler is sequential and does not submit forms. It is still automated traffic: only use it on sites you own or have permission to test. Each browser context gets a no-op `globalThis.__name` shim so DOM extraction works when the CLI is run via `tsx`, which would otherwise inject that helper into `page.evaluate` callbacks.

## Analysis

### Categories

`CATEGORIES` in `src/analysis/categories.ts` is the registry. Each entry has:

| Field | Meaning |
|---|---|
| `id` | Matches `CATEGORY_IDS` and the report section |
| `idPrefix` | `SEC`, `QUA`, `PERF`, `A11Y`, `ARCH`, `TECH`, `OWN`, `CUST` |
| `appliesTo` | `code`, `web`, or both. Accessibility is web-only. |
| `perBatch` | `true` → run on every chunk. `false` (`technology`, `ownership`) → one sampled batch plus the deterministic inventory, to save quota. |
| `prompt` | `(ctx) => { system, user }` |

`resolveCategories(config, kind)` drops inapplicable ids, and injects `custom` when `customRulesFile` is set.

### Chunking

`chunkItems(items, budget)` packs files/pages into batches whose estimated tokens (via `src/llm/tokens.ts`) fit `chunkTokenBudget`. Oversized single items are truncated with a marker rather than dropped. `sampleItems` picks a representative subset (high-priority files first) for inventory-style categories.

### Prompts

Every category prompt is built by `buildSystemPrompt` + `buildUserPrompt` (`src/analysis/prompts/shared.ts`):

- The system prompt states the role, the focus list, what to avoid, and the **strict JSON contract** (`FINDINGS_JSON_CONTRACT`): an object `{ findings: [...], notes?: string }` with a closed set of fields and severities.
- The user prompt contains the deterministic inventory (when relevant) and the material, each item headed `### File: <id>` or `### Page: <url>` with optional line numbers so the model can cite `location.file` / `location.line` / `location.url`.

The synthesis prompt (`prompts/synthesis.ts`) receives finding titles, severities, locations and the inventories, and asks for `{ executiveSummary, architectureOverview, technologySummary, ownershipSummary, topRisks, duplicateGroups }`.

### Analyzer

`analyze()` iterates `categories × batches` with `mapLimit(concurrency)`. For each call:

1. Build the prompt, wrap as `LlmRequest` with `meta: { kind: 'analysis', category, label }`.
2. `provider.complete(request)`.
3. `extractJson` (strip fences / think-blocks, find the first object, repair truncation).
4. `parseAnalysisResponse` (zod, extra fields ignored, unknown severities dropped).
5. Convert to `Finding` via `toFinding` (location normalised, confidence clamped).
6. Record usage. A thrown `LlmError` of kind `content` or a parse failure marks that batch failed; the category becomes `partial` and the run continues. Auth/quota/server errors propagate so the fallback chain can advance.

### Synthesis

`synthesize()`:

1. `dedupeHeuristically` collapses findings in the same category whose title+location are near-identical.
2. `assignIds` numbers them `PREFIX-001`, `PREFIX-002`, ... in severity-then-title order.
3. If `synthesize` is enabled, one more LLM request produces the narrative and `duplicateGroups`. `mergeGroups` only merges within a category (cross-category groups are ignored) and keeps the more severe / more specific finding, recording the loser in `mergedFrom`.
4. If that request fails, `deterministicNarrative` writes a template summary from counts and the inventories so the report is never empty.

## LLM layer

See [PROVIDERS.md](PROVIDERS.md) for adapters. The pieces the rest of the app depends on:

- **`LlmProvider`**: `id`, `model`, `complete(req): Promise<LlmResponse>`, `ping()`.
- **`LlmError`**: `kind` ∈ `auth | rate_limit | quota | server | network | timeout | bad_request | content | unknown`, with `retryable` and `fallbackEligible` getters.
- **`withRetry`**: exponential backoff, honours `Retry-After`, only for `retryable` kinds.
- **`RateLimiter`**: sliding window of `rpm` timestamps; `rpm === 0` disables it.
- **`FallbackProvider`**: wraps `ManagedProvider[]` (each with its own limiter). On a `fallbackEligible` error after retries, it permanently advances and records a `FallbackEvent`. It never goes back during the same run.

`createProviderChain` builds the primary (with user overrides applied) plus every configured fallback that has credentials, skipping the rest with a log line.

## Reporting

`writeReports` creates `output.dir/<timestamp>-<slug>/` and writes each requested format. The slug is derived from the target's last path segment (or hostname for URLs), sanitised for Windows (trailing dots/spaces stripped). `--dry-run` reports carry a banner that findings are placeholders.

`--fail-on <severity>` is applied in the CLI *after* writing, and is ignored during dry-run. Exit 3 means the gate fired; exit 2 is reserved for configuration/provider failures.

## Extension points

| Want to... | Change |
|---|---|
| Add a category | New prompt builder in `analysis/prompts/`, entry in `CATEGORIES`, id in `CATEGORY_IDS`. |
| Add a hosted LLM | Preset in `presets.ts`, case in `factory.ts` (reuse `openai-compatible` if it speaks chat completions), id in `PROVIDER_IDS`. |
| Tighten/loosen what files are kept | `BUILT_IN_IGNORES` and `priorityScore` in `scanners/code/collect.ts`. |
| Detect a new framework | Pattern in `scanners/code/inventory.ts` or `scanners/web/inventory.ts`. |
| Change the JSON contract | `FINDINGS_JSON_CONTRACT` plus `analysis/schema.ts` and `report/types.ts` together. |
| Embed in another tool | `import { loadConfig, runAudit } from 'ajc-dev-code-auditor'` (`src/index.ts`). |

## Testing

Vitest runs under `tests/`. Suites cover config merge, LLM retry/fallback/JSON extraction (fetch stubbed), code collection/inventory/ownership on a fixture repo, analysis parse/dedupe/ids, report renderers, an end-to-end mock-provider run, and a real Playwright crawl against an in-process HTTP server (skipped if Chromium is not installed).
