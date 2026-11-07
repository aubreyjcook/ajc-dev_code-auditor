# Example project rules

Pass this file with `-r examples/custom-rules.md`. Trim or replace the rules
with yours. Each rule has a stable id so findings can cite it (`[R1] ...`).

These are illustrations, not this repository's actual policy.

## Backend

R1. All HTTP request handlers must validate input with a schema library
    (zod, valibot, arktype, or similar) before reading `req.body`, `req.query`,
    or `req.params` and before touching the database.

R2. Database access lives in `src/repositories/**` (or `src/db/**`). Route
    handlers and service modules must not import `pg`, `mysql2`, `better-sqlite3`,
    `mongoose`, or `prisma` directly.

R3. Secrets, tokens, and connection strings must come from `process.env` or a
    secrets manager. Hard-coded passwords, API keys, or JWT secrets are
    forbidden, including "placeholder" defaults that work in production.

R4. Do not catch errors only to `console.log` / `console.error` and continue.
    Re-throw, or call the project logger and return a structured error.

## Logging and observability

R5. Application code under `src/**` must not call `console.log`, `console.debug`,
    or `console.info`. Use the project `logger` module. `console.error` is
    allowed only in CLI entry points and fatal process handlers.

R6. Every outbound HTTP call must set an explicit timeout. `fetch` without
    `AbortSignal` / `timeout` is a violation.

## Frontend / web

R7. Do not use `dangerouslySetInnerHTML` or `innerHTML` with data that originated
    from the user, a URL, or an API response, unless the value is passed through
    a sanitizer immediately before.

R8. Images must have a non-empty `alt` attribute. Decorative images use `alt=""`.

R9. Interactive controls (`<button>`, `<a href>`, `<input>`) must be reachable
    by keyboard and have an accessible name (visible text, `aria-label`, or
    `<label>`).

## Process / hygiene

R10. Do not commit `TODO`, `FIXME`, or `HACK` comments that mention a person
     or a ticket without a tracker id (e.g. `TODO(JIRA-1234): ...` is fine;
     `TODO: fix later` is not).

R11. New exported functions and public classes need a JSDoc comment describing
     behaviour and parameters. One-line internals do not.

R12. Do not disable linters or type-checks with `eslint-disable`, `ts-ignore`,
     `ts-nocheck`, or `any` unless the next line explains why.
