# Custom rules

The `custom` category exists so the auditor can enforce **your** conventions, not just generic best practice. You write the rules in a plain-text or Markdown file; they are inserted verbatim into the model prompt. Findings cite the rule they violate.

## Enabling

```bash
pnpm audit code . -r ./team-rules.md                  # custom + all default categories
pnpm audit code . -r ./team-rules.md -c custom        # custom only (cheapest)
pnpm audit web  https://staging.example.com -r ./web-rules.md -c custom,accessibility
```

Or in `auditor.config.json`:

```json
{
  "analysis": {
    "customRulesFile": "./team-rules.md"
  }
}
```

The path is resolved against the current working directory. Setting a rules file **enables** `custom` even if it is not listed in `categories`. Without a file, the category is skipped.

## How the model sees them

The custom prompt (`src/analysis/prompts/custom.ts`) tells the model:

- Act as a reviewer of **only** the supplied rules.
- Do not invent rules or report general best practice (other categories cover that).
- Do not report compliance — empty `findings` is the correct answer when nothing is wrong.
- Prefix each finding title with the rule identifier or a short quote of the rule, e.g. `[R3] Service imports pg directly`.
- Put the rule text in `references`.

The rules file is copied into the system prompt between `-----` markers. There is no parser: numbering, headings, bullet lists and prose all work. Keep the file short enough that it plus one chunk of source still fits `chunkTokenBudget` (default 24k tokens).

## Writing rules that fire

The model is only as precise as the rule. Rules that work well:

- Are **testable from the material**. "HTTP handlers must parse the body with zod before touching the database" is checkable in a file. "Code should be elegant" is not.
- Have a **stable identifier** (`R1`, `SEC-INTERNAL-4`, `FEAT-AUTH-2`) so reports and later diffs can refer to them.
- Name **paths, modules, APIs, or patterns** that actually appear (`src/repositories/**`, `logger`, `pg`, `dangerouslySetInnerHTML`).
- Say what **not** to do, or what **must** be done. "Prefer X" is weaker than "Do not import Y outside Z".
- Stay **in one concern**. Split security house-rules, frontend house-rules, and process rules into sections (or files you swap with `-r`).

Rules that disappoint:

- Duplicates of the built-in `security` / `quality` / `architecture` prompts. You will get the same finding twice with different ids.
- References to artefacts the scanner never sends (Jira tickets, Slack, production metrics, files in `node_modules`).
- Huge policy dumps. Truncation drops the last rules first; split or summarise.

Because `custom` is `perBatch: true`, every chunk of source/pages is checked. A rule about `package.json` scripts will only fire in the batch that contains that file; that is expected.

## Findings in the report

Custom findings use ids `CUST-001`, `CUST-002`, ... They appear in the Markdown report under **Custom rules**, in `report.json` as `findings[].category === "custom"`, and in the severity matrix. `producedBy` records which provider/model emitted them. Synthesis may merge near-duplicate custom findings within the category; it will not merge them into `SEC-*` even if the text overlaps.

## Library use

```ts
import { loadConfig, runAudit } from 'ajc-dev-code-auditor';

const config = loadConfig({
  cliOverrides: {
    analysis: { customRulesFile: './team-rules.md', categories: ['custom'] },
  },
});
const { report } = await runAudit({ kind: 'code', source: '.', config, noWrite: true });
const violations = report.findings.filter((f) => f.category === 'custom');
```

## Example

See [`examples/custom-rules.md`](../examples/custom-rules.md) for a complete file you can copy and trim.
