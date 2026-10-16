# Money verification map

This directory is the maintained source for verifying the user-facing behavior of Money. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch Money with `.cursor/skills/verify-money/scripts/verify-money launch` and require `"ok": true`.
- The instance listens on `http://127.0.0.1:<port>` (the launch JSON `baseUrl`). The port is chosen from 4173 upward. It is not port 3000 unless 4173 was already taken by something else and the doctor URL says so.
- Postgres data for the run is only under `/tmp/money-verify/<runId>/pg`.
- The database has migrations applied and no users until a recipe creates one.
- Run `.cursor/skills/verify-money/scripts/verify-money doctor` and require `"ok": true`, the expected `baseUrl`, and `"db": true`.
- Never drive an instance that was not started by this verification run.
- The helper's browser is 1280×800, so the desktop sidebar is the entry point. Do not use the mobile More menu at this width.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names. The helper clicks and fills only a single visible match.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run browser actions through `.cursor/skills/verify-money/scripts/verify-money browser`.
- Run read-only SQL through `.cursor/skills/verify-money/scripts/verify-money db query`.
- Relative evidence paths are stored under `/tmp/money-verify-evidence/<runId>/`. Do not remove them during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with Money visible (the sidebar wordmark or the page heading).
- Mutation proof includes a second user-facing view or a `SELECT` on `"user"`.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-money` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Create account](./create-account.md) covers registration from `/register` and the signed-in empty dashboard that follows.
- [Sign in](./sign-in.md) covers `/login`, a rejected password, and a successful return to the dashboard.
- [Dashboard](./dashboard.md) covers the empty signed-in home page and its import link.
- [Transactions](./transactions.md) covers the empty transaction list, account label, and search that still matches nothing.
- [Spend report](./spend.md) covers the empty spend report reached from the sidebar.
