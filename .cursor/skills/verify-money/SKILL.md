---
name: verify-money
description: Drive the Money web app in a browser and prove what a signed-in user sees. Use when a change touches pages, auth, the dashboard, transactions, or spend and unit tests are not enough.
---

# Verify Money

Money is a Next.js personal finance tracker. The user-facing surface is the website (desktop sidebar at a 1280px-wide window). Public pages are `/login` and `/register`. Everything else redirects to `/login` until the browser has a session. There is no Playwright suite in the app. This skill starts an isolated Postgres and `next dev`, then drives Chrome.

Other surfaces exist and are out of this map: Bank of Baroda PDF import (`/import`), reimbursements, people, review, timeline, and the Ask Money assistant. Do not treat a unit test or a direct database insert as proof of a page.

## Launch

From the repo root, once per machine:

```bash
pnpm install
npm install --prefix .cursor/skills/verify-money/scripts
```

`pnpm install` installs the app. The second command installs this skill's helper (embedded Postgres and Playwright). Playwright uses the installed Google Chrome (`channel: chrome`); it does not download a second browser.

Start one isolated instance:

```bash
.cursor/skills/verify-money/scripts/verify-money launch
```

Launch is finished only when it prints JSON with `"ok": true`. That means all of the following happened:

1. A new Postgres cluster was created under `/tmp/money-verify/<runId>/pg` and a database named `money` was created. The cluster is not the user's Neon database.
2. `pnpm exec drizzle-kit migrate` applied the repo migrations to that database. A fresh database has no users. Do not run `bootstrap-owner` against it.
3. `node scripts/security/preflight.mjs` passed.
4. `pnpm exec next dev -H 127.0.0.1 -p <port>` is serving. The port starts at `4173` and moves up if that port is taken.
5. `GET /login` returned HTTP 200 with the Money document (the first paint is `Loading…` while the session check runs), and a headless Chrome window then showed the `Sign in` heading.

The process environment sets `DATABASE_URL`, `AUTH_SECRET`, and `AUTH_URL` for that instance and removes `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` so registration is not rate-limited by a shared Redis. `process.env` wins over `.env.local` for those keys.

A second instance needs its own id so it does not share the port, database directory, or Chrome profile:

```bash
MONEY_VERIFY_RUN=run-b .cursor/skills/verify-money/scripts/verify-money launch
```

Commands without `MONEY_VERIFY_RUN` use the run id written to `/tmp/money-verify/latest`. Launch refuses to start a second default instance while the latest one is still alive.

## Doctor

```bash
.cursor/skills/verify-money/scripts/verify-money doctor
```

Exit 0 means this run is worth driving. The JSON reports the base URL, database directory, evidence directory, Next pid, installed `next` version, that `GET /login` is the Money sign-in shell, and that `select 1` succeeded on this run's database. The `Sign in` heading itself appears after the session check; a browser `open /login` confirms it. Exit 1 means do not drive it. Run doctor again after anything looks wrong. Never drive a Money process this run did not start (including a dev server on port 3000).

## Drive

The helper's Chrome profile is persistent for the run, headless, and 1280×800. At that width the sidebar is visible and the mobile tab bar is not. Every `click` and `fill` targets one visible role. The viewport is fixed by the helper; do not resize it.

```bash
.cursor/skills/verify-money/scripts/verify-money browser open /register --expect "Create account"
.cursor/skills/verify-money/scripts/verify-money browser click --role link --name "Dashboard"
.cursor/skills/verify-money/scripts/verify-money browser fill --role textbox --name "Email" --value "verify-user@example.com"
```

`--role` and `--name` are matched exactly against the accessible name. `--expect` waits until that text is visible (30s). `open` accepts a path on this instance.

Read-only database check, one `SELECT`, no semicolon:

```bash
.cursor/skills/verify-money/scripts/verify-money db query "select email from \"user\" where email = 'verify-user@example.com'"
```

Feature recipes live in `features/`. Read `features/README.md` first. Drive the feature file that matches the change. A proof of one entry point does not cover the others.

## Evidence

Relative `--path` values are written under `/tmp/money-verify-evidence/<runId>/`. Absolute paths are used as given. Cleanup never deletes that directory.

For a UI proof, capture both the action and the resulting state:

- an ARIA snapshot (`browser snapshot --path` writes the page's ARIA tree)
- a full-page screenshot (`browser screenshot --path …`)

The snapshot command is:

```bash
.cursor/skills/verify-money/scripts/verify-money browser snapshot --path artifacts/<feature>/page.aria.txt
.cursor/skills/verify-money/scripts/verify-money browser screenshot --path artifacts/<feature>/page.png
```

Also record the feature id and the entry point in the note you leave with the artifacts. When a recipe changes data, prove the side effect with `db query` or by opening the page again. Do not call server actions, SQL inserts, or React state setters as the user action. There is no test-only endpoint.

A fresh database has no statements. Empty-account copy is the real result for a new registration. A journey that needs an imported Bank of Baroda PDF fails closed when that file is not part of the run; do not substitute the empty state for it.

## Cleanup

```bash
.cursor/skills/verify-money/scripts/verify-money cleanup
```

This sends `SIGTERM` (then `SIGKILL`) to the Next process group recorded for this run, stops that run's Postgres, and deletes `/tmp/money-verify/<runId>`. It does not delete `/tmp/money-verify-evidence/<runId>`. It does not kill other `next` or `postgres` processes by name. Run cleanup after a failed launch too, so a half-started cluster is not left behind. Set `MONEY_VERIFY_RUN` when cleaning a named second instance.

## Helpers

| Command | What it does |
|---|---|
| `.cursor/skills/verify-money/scripts/verify-money launch` | Start isolated Postgres, migrate, start `next dev`, wait until `/login` shows Sign in |
| `.cursor/skills/verify-money/scripts/verify-money doctor` | Read-only health report. Exit 0 only when the instance is drivable |
| `.cursor/skills/verify-money/scripts/verify-money browser open <path> [--expect TEXT]` | Open a path on this instance |
| `.cursor/skills/verify-money/scripts/verify-money browser click --role ROLE --name NAME [--expect TEXT]` | Click the one visible control with that accessible name |
| `.cursor/skills/verify-money/scripts/verify-money browser fill --role ROLE --name NAME --value VALUE` | Fill that control |
| `.cursor/skills/verify-money/scripts/verify-money browser snapshot --path FILE` | Write the body ARIA snapshot |
| `.cursor/skills/verify-money/scripts/verify-money browser screenshot --path FILE` | Write a full-page PNG |
| `.cursor/skills/verify-money/scripts/verify-money db query "select …"` | Run one read-only SELECT against this instance |
| `.cursor/skills/verify-money/scripts/verify-money cleanup` | Stop this instance and delete its scratch data, keeping evidence |

The executable is `scripts/verify-money` (bash). It runs `scripts/verify-money.mjs`. Both live next to this file. Invoke them from the repo root so the relative path above resolves.
