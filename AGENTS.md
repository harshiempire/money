# Agent guide — Money app

This file is the **source of truth** for AI agents and contributors working on this repo. Read it before changing auth, DB, or server actions.

## What this app is

Personal finance tracker (Next.js App Router): Bank of Baroda PDF import, transactions, categories, splits/reimbursements, dashboard/net spend. Stack: **Bun**, **Next.js 16**, **Drizzle ORM**, **Neon Postgres** (via `postgres` TCP driver + `drizzle-orm/postgres-js`), **Auth.js v5** (next-auth beta), **Effect** (ingest pipeline).

Multi-tenant by `user_id`: every domain row belongs to a user. One special legacy user id holds pre-auth data (see below).

---

## Auth model (current)

| Topic | Choice |
|-------|--------|
| Provider | Credentials (email + password) |
| Sessions | **JWT** (`session.strategy: "jwt"`) — required for Credentials; DB `session` table exists for future OAuth |
| Adapter | DrizzleAdapter — users/accounts stored; JWT avoids per-request session DB reads on Neon |
| Password hashing | `bcryptjs` cost **12** via [`src/lib/password.ts`](src/lib/password.ts) |
| Revocation | `user.token_version` — JWT embeds version; mismatch forces re-login; bump via [`scripts/bump-token-version.ts`](scripts/bump-token-version.ts) |
| Registration | **Open** — [`src/app/auth/actions.ts`](src/app/auth/actions.ts) `registerUser` + `/register` |
| Route protection | [`middleware.ts`](middleware.ts) exports `auth`; public: `/login`, `/register`, `/api/auth/*` |

### Legacy owner / seed user (do not break)

Pre-auth, all finance data was keyed to a fixed user:

```ts
SEED_USER_ID = "00000000-0000-0000-0000-000000000001"
```

Defined in [`src/db/constants.ts`](src/db/constants.ts) (re-exported from [`src/db/seed-user.ts`](src/db/seed-user.ts)).

**Bootstrap** ([`scripts/bootstrap-owner.ts`](scripts/bootstrap-owner.ts)) sets `email` + `password_hash` on **that same row** — no FK migration, no second user for legacy data. The first human operator logs in as this user and sees all historical transactions/imports.

New users get a **new UUID** via registration; they start with empty data (`ensureDefaultCategories` + `getOrCreateAccountForBank` on first use).

### Deprecated (must not use in app code)

- `ensureSeedUser()` — throws; use `requireCurrentUser()` or `requireCurrentUserAction()`
- `ensureDefaultBobAccount()` — re-export alias only; use `getOrCreateAccountForBank(userId, "bob")`

---

## Key files map

### Auth

| File | Role |
|------|------|
| [`src/auth.ts`](src/auth.ts) | NextAuth config, Credentials `authorize`, jwt/session callbacks, `authorized` for middleware |
| [`src/app/api/auth/[...nextauth]/route.ts`](src/app/api/auth/[...nextauth]/route.ts) | GET/POST handlers |
| [`middleware.ts`](middleware.ts) | Re-exports `auth` as middleware |
| [`src/lib/auth/require-current-user.ts`](src/lib/auth/require-current-user.ts) | `requireCurrentUser()` (pages → redirect `/login`), `requireCurrentUserAction()` (actions → throw) |
| [`src/lib/auth/ownership.ts`](src/lib/auth/ownership.ts) | `assertTransactionOwned`, `assertCategoryOwned`, `assertCounterpartyOwned`, `assertSplitParticipantOwned`, `assertTransactionsOwned`, `assertAccountOwned` |
| [`src/lib/auth/forbidden.ts`](src/lib/auth/forbidden.ts) | `ForbiddenError` / `throwForbidden()` |
| [`src/lib/rate-limit.ts`](src/lib/rate-limit.ts) | Upstash login/register limits; **no-op** if `UPSTASH_*` unset (warns in dev) |
| [`src/types/next-auth.d.ts`](src/types/next-auth.d.ts) | `session.user.id` typing |
| [`src/components/SessionProvider.tsx`](src/components/SessionProvider.tsx) | Client wrapper for `signIn`/`signOut` |

### Data access

| File | Role |
|------|------|
| [`src/db/index.ts`](src/db/index.ts) | App DB client (`postgres.js` + `resolveDatabaseUrl`) — has `import "server-only"` |
| [`src/db/connection-url.ts`](src/db/connection-url.ts) | Strips `channel_binding` from `DATABASE_URL` |
| [`src/db/schema.ts`](src/db/schema.ts) | Drizzle schema; Auth.js tables use names `user`, `account`, `session`; domain bank accounts are **`money_account`** |
| [`src/db/money-account.ts`](src/db/money-account.ts) | `getOrCreateAccountForBank(userId, "bob")` |
| [`scripts/lib/db.ts`](scripts/lib/db.ts) | **CLI-only** DB client (no `server-only`) — use in `scripts/*` |

### Pages (all use auth + tenant scope)

| Route | Notes |
|-------|--------|
| `/` | Dashboard; imports for default period filtered by `account.id` |
| `/transactions` | |
| `/timeline` | Imports for period scoped by account |
| `/reimbursements` | |
| `/import` | **Recent imports** must filter `imports.account_id = account.id` (was a global leak pre-auth) |
| `/login`, `/register` | Public |

Pattern on every protected page:

```ts
const user = await requireCurrentUser();
const account = await getOrCreateAccountForBank(user.id, "bob");
// scope queries with account.id and/or user.id
```

### Server actions (must stay secured)

**Rule:** First line = `requireCurrentUserAction()`; then ownership asserts for every client-supplied id. Never trust `userId` or `accountId` from the client.

| File | Exports |
|------|---------|
| [`src/app/import/actions.ts`](src/app/import/actions.ts) | `uploadStatement` (1) |
| [`src/app/transactions/actions.ts`](src/app/transactions/actions.ts) | 8 (category, counterparty, transfer, note, candidates, bulk note, autoDetectTransfers) |
| [`src/app/transactions/split-actions.ts`](src/app/transactions/split-actions.ts) | 4 (createSplit, deleteSplit, recordSettlement, clearSettlement) |
| [`src/app/auth/actions.ts`](src/app/auth/actions.ts) | `registerUser` |

**Middleware does not protect server actions** — each action must authenticate and authorize itself.

---

## Database & migrations

### Schema highlights

`user` table (Auth.js name `"user"`):

- `password_hash` — nullable (OAuth users later); Credentials users must have it
- `token_version` — integer, default 0

### `db:push` vs `db:migrate`

This project may have been created with **`bun run db:push`**, leaving tables in place but **`drizzle.__drizzle_migrations` empty**. Then **`bun run db:migrate` fails** trying to re-run `0000` (`CREATE TABLE` already exists).

**Fix for existing push-created DBs:**

```bash
bun run baseline-migrations   # marks 0000–0002 as applied
bun run db:migrate            # applies 0003+ only (e.g. password_hash, token_version)
```

**Fresh DB:** `bun run db:migrate` from scratch is fine.

**Quick dev sync (no journal):** `bun run db:push` — OK for local only; prefer migrate + baseline for prod.

Migration journal: [`drizzle/migrations/meta/_journal.json`](drizzle/migrations/meta/_journal.json).

### CLI scripts and `server-only`

**Never import** [`src/auth.ts`](src/auth.ts) or [`src/db/index.ts`](src/db/index.ts) from Bun CLI scripts — they pull `server-only` and crash.

| Script | Purpose |
|--------|---------|
| [`scripts/bootstrap-owner.ts`](scripts/bootstrap-owner.ts) | Set email/password on `SEED_USER_ID` |
| [`scripts/baseline-migrations.ts`](scripts/baseline-migrations.ts) | Fix push/migrate mismatch |
| [`scripts/bump-token-version.ts`](scripts/bump-token-version.ts) | Invalidate all JWTs for a user |
| [`scripts/lib/db.ts`](scripts/lib/db.ts) + [`src/lib/password.ts`](src/lib/password.ts) | Script-safe DB + hashing |

---

## Environment variables

Copy [`.env.example`](.env.example).

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | Yes | Neon Postgres |
| `AUTH_SECRET` | Yes | JWT signing (`openssl rand -base64 32`) |
| `AUTH_URL` | Prod | Canonical URL |
| `BOOTSTRAP_EMAIL` | Once | Seed owner login email |
| `BOOTSTRAP_PASSWORD` | Once | Seed owner password (≥12 chars) |
| `UPSTASH_REDIS_REST_URL` | Prod recommended | Rate limits |
| `UPSTASH_REDIS_REST_TOKEN` | Prod recommended | Rate limits |
| `SKIP_AUTH_BOOTSTRAP_CHECK` | Optional | Skip prod instrumentation gate |

---

## Deploy / first-time setup order

1. `bun install`
2. Set env (see above)
3. If DB was push-created: `bun run baseline-migrations`
4. `bun run db:migrate` (or `db:push` on empty dev DB)
5. `bun run bootstrap-owner` — **before** serving traffic in prod
6. `bun run build` / deploy
7. Log in at `/login` with `BOOTSTRAP_EMAIL` — confirm legacy data on dashboard
8. Optional: register a second user at `/register` — must see **empty** tenant

Production: [`src/instrumentation.ts`](src/instrumentation.ts) fails fast if seed row has no `password_hash` (unless `SKIP_AUTH_BOOTSTRAP_CHECK=1`).

---

## Security checklist (when adding features)

- [ ] New page: `requireCurrentUser()` + scope queries by `account.id` / `user.id`
- [ ] New server action: `requireCurrentUserAction()` + ownership assert on every id from client
- [ ] Never accept `accountId` / `userId` from FormData for authorization — resolve from session
- [ ] Import/upload: bind to `getOrCreateAccountForBank(sessionUser.id, "bob")` only
- [ ] Credentials `authorize`: fail closed if `!passwordHash`
- [ ] Do not reintroduce runtime `ensureSeedUser()` inserts

---

## Common commands

```bash
bun run dev
bun run typecheck
bun run build
bun run db:generate    # after schema.ts changes
bun run db:migrate
bun run db:push
bun run baseline-migrations
bun run bootstrap-owner
bun run db:studio
```

---

## Domain / ingest (unchanged by auth)

- PDF parsing: [`src/domain/adapters/bob/parser.ts`](src/domain/adapters/bob/parser.ts), [`src/domain/pdf/`](src/domain/pdf/)
- Ingest: [`src/domain/ingest/pipeline.ts`](src/domain/ingest/pipeline.ts) — receives `accountId` from trusted server action only
- Transfers: [`src/domain/transfers/detect.ts`](src/domain/transfers/detect.ts)

---

## Out of scope (v1 — do not assume implemented)

- Email verification
- OAuth (schema ready via DrizzleAdapter)
- Change-password UI (use `bump-token-version` + manual hash update for now)
- Multi-bank account picker UI (only implicit `"bob"` per user)
- DB session strategy

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|--------|-----|
| `db:migrate` exits 1, tables exist | Push-created DB, empty migration journal | `baseline-migrations` then `db:migrate` |
| `server-only` error in bootstrap script | Imported `src/auth` or `src/db/index` from CLI | Use `scripts/lib/db` + `src/lib/password` |
| Login works but empty dashboard for bootstrap user | Wrong user / new account | Confirm session `user.id === SEED_USER_ID`; re-run bootstrap |
| All imports visible to every user | Missing `account_id` filter on import list | Filter by current user's BoB account |
| Rate limit never triggers | Upstash env missing | Set `UPSTASH_*` or accept dev no-op |

---

## History (for context)

- App originally used a single seed user (`owner@local`) with no login — all server actions were effectively public.
- Auth added: JWT Credentials, open registration, in-place bootstrap on `SEED_USER_ID` to preserve finance FKs, ownership checks on 13 server actions, tenant-scoped pages.

When in doubt: **preserve `SEED_USER_ID` data**, **authenticate every server action**, **scope every query by the current user's account**.

---

## Cursor Cloud specific instructions

### Services

| Service | Command | Notes |
|---------|---------|-------|
| Next.js dev | `bun run dev` | Port **3000**; loads `.env.local` |
| Local Postgres + Neon proxy | `sudo docker compose -f docker-compose.local.yml up -d` | Required when `DATABASE_URL` uses `db.localtest.me` (see below) |
| Drizzle Studio (optional) | `bun run db:studio` | DB browser |

### Database: Neon cloud vs local proxy

Production and most dev setups use a **Neon** `DATABASE_URL`. The app uses `@neondatabase/serverless` (not plain `postgres`).

For Cloud Agent VMs **without** a Neon URL, use the committed `docker-compose.local.yml` (Postgres 17 + [local-neon-http-proxy](https://neon.com/guides/local-development-with-neon)):

```bash
sudo docker compose -f docker-compose.local.yml up -d
cp .env.example .env.local   # then set DATABASE_URL below + AUTH_SECRET + BOOTSTRAP_*
```

`.env.local` for local proxy:

```
DATABASE_URL=postgres://postgres:postgres@db.localtest.me:5432/main
AUTH_SECRET=<openssl rand -base64 32>
BOOTSTRAP_EMAIL=owner@local.dev
BOOTSTRAP_PASSWORD=<≥12 chars>
SKIP_AUTH_BOOTSTRAP_CHECK=1
```

`src/db/index.ts` and `scripts/lib/db.ts` auto-configure the Neon driver when the hostname is `db.localtest.me`. **Drizzle CLI** (`bun run db:migrate`) connects to Postgres on port 5432 directly; the proxy on **4444** is for the serverless driver only.

First-time DB setup:

```bash
bun run db:migrate
bun run bootstrap-owner
```

### Lint caveat

`bun run lint` (`next lint`) may fail on Next.js 16 without an `eslint.config.*` file. Use `bun run typecheck` and `bun test` for CI-style checks until ESLint flat config is added.

### Hello-world smoke test

1. `bun run dev` → open `http://localhost:3000/login`
2. Sign in with `BOOTSTRAP_EMAIL` / `BOOTSTRAP_PASSWORD`
3. Dashboard should show the **Money** heading; `/transactions` loads (empty tenant is OK for new users)
