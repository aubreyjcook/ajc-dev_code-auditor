# Configuration reference

Settings are assembled from four layers. Later layers win; **arrays are replaced, not concatenated**.

```
built-in defaults  <  environment (AUDITOR_*)  <  auditor.config.json  <  CLI flags
```

Each layer is validated on its own so a typo names the offending source (`env`, `file`, `cli`, or `merged`).

API keys are **not** part of this merge. Adapters read them from process environment (`GEMINI_API_KEY`, `GROQ_API_KEY`, ...) so they never land in `report.json` or logs. Do not put keys in `auditor.config.json`.

A missing `./auditor.config.json` is fine. An explicit `--config path` that does not exist is an error (exit 2).

Copy [`auditor.config.example.json`](../auditor.config.example.json) as a starting point. Every field is optional.

`.env` in the working directory is loaded by dotenv **without** overriding variables already set in the shell.

`--dry-run` is applied after the merge and forces `llm.provider = "mock"` with an empty fallback list, regardless of other settings.

---

## `llm`

| Field | Type | Default | CLI | Env |
|---|---|---|---|---|
| `provider` | `gemini` \| `groq` \| `openrouter` \| `mistral` \| `ollama` \| `openai` \| `openai-compatible` \| `anthropic` \| `mock` | `gemini` | `-p, --provider` | `AUDITOR_PROVIDER` |
| `model` | string | provider preset | `-m, --model` | `AUDITOR_MODEL` |
| `baseUrl` | URL | provider preset | `--base-url` | `AUDITOR_BASE_URL` |
| `apiKey` | string | *(from provider env var)* | — | *(provider-specific, e.g. `GEMINI_API_KEY`)* |
| `fallbackProviders` | provider id[] | `[]` | `--fallback` (comma-separated) | `AUDITOR_FALLBACK_PROVIDERS` |
| `requestsPerMinute` | int ≥ 0 or `null` | `null` (use preset) | `--rpm` | `AUDITOR_REQUESTS_PER_MINUTE` |
| `maxOutputTokens` | positive int | `4096` | — | — |
| `temperature` | 0–2 | `0.1` | — | — |
| `timeoutMs` | positive int | `120000` | — | — |
| `maxRetries` | int ≥ 0 | `4` | — | — |

Notes:

- `null` for `requestsPerMinute` means "use the preset's free-tier cap" (Gemini 8, Groq 25, OpenRouter 15, Mistral 30, Ollama 0 / unlimited, ...). `--rpm 0` (or `"requestsPerMinute": 0`) disables the client-side limiter.
- `model`, `baseUrl` and `apiKey` overrides apply **only to the primary** provider. Fallback providers always use their own preset + their own env key. See [PROVIDERS.md](PROVIDERS.md).
- `openai-compatible` has no default model or base URL; you must pass `--base-url` and `-m` (or `OPENAI_COMPATIBLE_BASE_URL` + `llm.model`).
- Preset RPM values and default models: `src/llm/presets.ts`.

---

## `analysis`

| Field | Type | Default | CLI | Env |
|---|---|---|---|---|
| `categories` | category id[] | all except `custom` | `-c, --categories` | — |
| `customRulesFile` | path or `null` | `null` | `-r, --rules` | — |
| `chunkTokenBudget` | int ≥ 2000 | `24000` | `--chunk-tokens` | — |
| `concurrency` | 1–16 | `1` | `--concurrency` | `AUDITOR_CONCURRENCY` |
| `synthesize` | boolean | `true` | `--no-synthesize` | — |

Category ids: `security`, `quality`, `performance`, `accessibility`, `architecture`, `technology`, `ownership`, `custom`.

- Inapplicable categories are skipped automatically (`accessibility` on a codebase; `custom` unless a rules file is set). Setting `-r` enables `custom` even if it was not listed in `-c`.
- Keep `concurrency` at 1 on free tiers. Raise it for paid or local (Ollama) providers.
- Lower `chunkTokenBudget` (8000–12000) for small local models or Groq's tight TPM cap.

---

## `code`

Used only by `audit code`.

| Field | Type | Default | CLI |
|---|---|---|---|
| `maxFiles` | positive int | `400` | `--max-files` |
| `maxFileBytes` | positive int | `200000` | `--max-file-bytes` |
| `include` | glob[] | `[]` (everything not ignored) | `--include` (repeatable, comma-separated) |
| `exclude` | glob[] | `[]` | `--exclude` (repeatable, comma-separated) |

Built-in ignores and `.gitignore` always apply first. `include`, when non-empty, is an additional allow-list on top of that. Files over `maxFileBytes` are skipped; when more than `maxFiles` remain, lowest-priority files are dropped (manifests and configs kept first). See [ARCHITECTURE.md](ARCHITECTURE.md#code-srcscannerscode).

---

## `web`

Used only by `audit web`.

| Field | Type | Default | CLI |
|---|---|---|---|
| `maxPages` | positive int | `10` | `--max-pages` |
| `maxDepth` | int ≥ 0 | `2` | `--max-depth` |
| `timeoutMs` | positive int | `30000` | `--timeout` |
| `runAxe` | boolean | `true` | `--no-axe` |
| `userAgent` | string | `ajc-dev-code-auditor/0.1 (+https://github.com/ajc-dev)` | — |
| `headless` | boolean | `true` | `--no-headless` |

The crawl is same-origin only. `maxDepth` 0 means "only the start URL".

---

## `output`

| Field | Type | Default | CLI | Env |
|---|---|---|---|---|
| `dir` | path | `./audit-output` | `-o, --out` | `AUDITOR_OUT_DIR` |
| `formats` | `markdown` and/or `json` | both | `--format` | — |

A timestamped sub-folder is created per run: `<dir>/<ISO-timestamp>-<target-slug>/report.md` and/or `report.json`. The terminal summary is always printed and is not a format.

---

## Top-level

| Field | Type | Default | CLI | Env |
|---|---|---|---|---|
| `logLevel` | `silent` \| `error` \| `warn` \| `info` \| `debug` | `info` | `-v` → `debug`, `-q` → `error`, `--log-level` | `AUDITOR_LOG_LEVEL` |
| `dryRun` | boolean | `false` | `--dry-run` | — |

`--fail-on <critical|high|medium|low|none>` is a CLI-only gate (default `none`). It is not stored in the config object. It is ignored during dry-run.

---

## Provider API keys and base URLs

These are read directly by adapters, not via `AUDITOR_*`:

| Provider | API key env | Base URL env | Default base URL |
|---|---|---|---|
| Gemini | `GEMINI_API_KEY` | `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` |
| Groq | `GROQ_API_KEY` | `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` |
| OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` |
| Mistral | `MISTRAL_API_KEY` | `MISTRAL_BASE_URL` | `https://api.mistral.ai/v1` |
| Ollama | *(none)* | `OLLAMA_BASE_URL` | `http://localhost:11434/v1` |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| openai-compatible | `OPENAI_COMPATIBLE_API_KEY` | `OPENAI_COMPATIBLE_BASE_URL` | *(required)* |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | `https://api.anthropic.com/v1` |

---

## Example files

Minimal `.env` (Gemini only):

```
GEMINI_API_KEY=AIza...
```

Chained free providers in `auditor.config.json`:

```json
{
  "llm": {
    "provider": "gemini",
    "fallbackProviders": ["groq", "openrouter", "ollama"]
  },
  "analysis": {
    "concurrency": 1,
    "chunkTokenBudget": 24000
  },
  "output": {
    "dir": "./audit-output"
  }
}
```

CI-oriented invocation (no config file needed):

```bash
pnpm audit code . \
  --config ./auditor.config.json \
  -c security,quality,ownership \
  --fail-on high \
  --format json \
  -o ./reports
```

See also [README → Configuration](../README.md#configuration) and [README → Free LLM providers](../README.md#free-llm-providers-default-and-fallbacks).
