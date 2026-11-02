# Plan: Effect actions + TanStack Form / Table / Query

Status: proposed (2026-11-01). TanStack DB is deferred until after Phase 5.

Decided 2026-11-02: no rewrite to TanStack Start. Stay on Next.js; keep Effect handlers framework-agnostic behind `defineAction` so a later move stays cheap.

## Goals

1. Server actions return **typed results** instead of throwing, so validation messages survive production builds.
2. Auth + ownership become **structurally required** (an action can't be written without them), not a convention in AGENTS.md.
3. One **schema per action input**, reused by the server action and by client forms.
4. The three settle/split dialogs lose their hand-rolled draft state (TanStack Form).
5. Review gets **bulk categorise** (TanStack Table).
6. On-demand client fetches get caching (TanStack Query).

## Current state (evidence)

- 29 server actions across 8 files: `transactions/actions.ts` (10), `split-actions.ts` (4), `net-event-actions.ts` (2), `reimbursements/actions.ts` (4), `reimbursements/owed-expense-actions.ts` (3), `talk/actions.ts` (4), `spend/actions.ts` (1), `import/actions.ts` (1, already Effect inside), `auth/actions.ts` (1).
- About 36 `throw new Error(msg)` for expected failures. Next 16 docs (`01-getting-started/10-error-handling.md`): "model expected errors as return values". In prod, thrown messages are replaced by a digest.
- Validators already return `{ ok: true } | { ok: false; message }` (`src/lib/splits/validate.ts`, `src/lib/net-events/validate.ts`). `NetEventValidationError` already carries a `code`. These lift into Effect almost for free.
- 16 client files call actions; 17 `catch` blocks read `err.message`.
- Effect is on **v4** (`effect@4.1.1`, pinned exactly; migrated 2026-11-02 with the official `effect-v3-to-v4` skill). `Schema` lives in `effect` (no new dependency). Effect code follows `node_modules/effect/AGENTS.md`; see AGENTS.md "Learning more about Effect".

---

## Phase 0: prove the bug, set up the branch (½ day)

- `next build && next start` against the local-dev Neon branch (`~/.money-scratch/local-dev/dev.sh`). Trigger `createSplit` on a credit row. Record what the dialog shows.
- If messages *do* survive, Goal 1 becomes nice-to-have, and Phases 1–2 get justified by Goals 2–3 alone. Re-decide then.
- **Result (2026-11-02): confirmed.** A throwaway app on this repo's Next 16 install, `next build` + `next start`. An action doing `throw new Error("Only a payment you made can be split.")` sent the client only `E{"digest":"2609852741"}`; the message appeared only in the server log. The same message *returned* as `{ ok: false, message }` arrived intact. So every `catch (err) { err.message }` in the dialogs shows React's generic production error instead of the validation text.
- Commit the unrelated in-flight work (`talk/`, `docs/security/`, `.env.example`, `transactions/page.tsx`) separately first, so these PRs stay clean.

## Phase 1: Effect action foundation (1 PR, about 1–2 days)

New `src/lib/action/`:

| File | Contents |
|---|---|
| `errors.ts` | `Schema.TaggedError`s: `Unauthenticated`, `Forbidden`, `NotFound`, `Invalid { message, field? }`, `Conflict { message }`. Map the existing `ForbiddenError` / `NetEventValidationError` into them. |
| `result.ts` | `type ActionResult<T> = { ok: true; data: T } \| { ok: false; code: string; message: string; field?: string }`. Client-safe (no `server-only`). |
| `services.ts` | `CurrentUser` (`Context.Service`, built from `auth()`), `Db` (wraps `db`, plus `withTransaction` that rolls back on a typed failure), `Revalidate` (collects paths; runs `revalidatePath` only on success). |
| `define-action.ts` | `defineAction({ input: Schema, handler: (input) => Effect<A, E, CurrentUser \| Db> })`. It decodes input, provides layers, catches defects (logs them and returns a generic message), and maps tagged errors to `ActionResult`. |
| `ownership.ts` | Effect versions of `assertTransactionOwned` etc. that fail with `Forbidden`. Same SQL as `src/lib/auth/ownership.ts`. |
| `validation.ts` | `fromValidation(v: Validation) => Effect<void, Invalid>` adapter for the existing pure validators. |

Client side: `src/lib/action/use-action.ts` is a small hook over `useTransition` that returns `{ run, pending, error }` from an `ActionResult`.

Rules this encodes (update AGENTS.md in the same PR):
- Every action is `export const x = defineAction(...)`. A lint/grep check in `check:integrity` rejects a bare `export async function` in `*actions.ts`.
- `userId` / `accountId` never come from the input schema.
- Unknown exceptions never reach the client verbatim.

Tests: `bun test` a `defineAction` with a fake `CurrentUser` / `Db` layer, covering unauthenticated → `Unauthenticated`, invalid input → `Invalid`, a defect becoming a generic message, and revalidation skipped on failure.

Open check, resolved 2026-11-02: `export const x = defineAction(...)` builds under Turbopack, and the action returns its `ActionResult` in `next start`.

**Status: done** on `feat/effect-actions`. Contents: `src/lib/action/{result,errors,services,validation,core,define-action,ownership,use-action}.ts`, 14 tests in `core.test.ts`, `scripts/check-actions.ts` (`bun run check:actions`), and AGENTS.md updated. No action is migrated yet; 2a is the first real use.

## Phase 2: migrate actions (one PR per file, riskiest first)

Each PR migrates the actions **and** their client callers together, because the return type changes.

| Order | File | Callers | Notes |
|---|---|---|---|
| 2a | `split-actions.ts` | SplitDialog, SettleDialog | **Done 2026-11-02.** Logic in `split-handlers.ts` (specs), thin `defineAction` wrappers in `split-actions.ts`. Verified: old-vs-new A/B run on local-dev (identical DB after every step), independent statement-by-statement review, `scripts/test-split-actions.ts` (34 checks), and HTTP calls through `next dev`. Pattern for 2b+: `*-handlers.ts` + thin `*-actions.ts`. |
| 2b | `net-event-actions.ts` | NetSettleDialog | `NetEventValidationError.code` becomes `Invalid`/`Conflict` with the same codes. 5 revalidate paths go through `Revalidate`. |
| 2c | `reimbursements/*.ts` | CashSettlementDialog, SplitAwaitingItem, ForgivenHistory | |
| 2d | `transactions/actions.ts` | RowActions, NoteDialog, ReviewLaterButton, AutoDetectButton, LinkedTransactionLink | Read actions (`getNoteCandidates`, `getLinkedTransactionPreview`) return `ActionResult` too, which prepares them for Query in Phase 5. |
| 2e | `spend`, `talk` | CategoryAccordion, TalkClient | Talk: add `Effect.timeout` + `Effect.retry` around the model call in `lib/talk/codex.ts`. |
| 2f | `import/actions.ts` | UploadForm | Already Effect; just route through `defineAction` and reuse its tagged errors. |
| 2g | `auth/actions.ts` | RegisterForm | Last, and carefully: rate limit stays first, and no `CurrentUser` (public). Use a `definePublicAction` variant. |

Done when: zero `throw new Error` for expected cases in action files, zero `err.message` reads in client callers, and AGENTS.md's action table points at `defineAction`.

## Phase 3: TanStack Form on the dialogs (one PR per dialog)

Dependency: `@tanstack/react-form`. Validation uses the Phase 1 input schemas through Standard Schema (`Schema.toStandardSchemaV1(...)`, the v4 name), so client and server rules are the same code.

| Order | Dialog | Lines / useState | Win |
|---|---|---|---|
| 3a | `SplitDialog.tsx` | 505 / 4 | Participant field array, "your share" derived field, per-row errors |
| 3b | `SettleDialog.tsx` | 623 / 6 | Allocation rows, capacity error shown on the row that exceeds it |
| 3c | `NetSettleDialog.tsx` | 841 / 9 | Biggest. Receivable/payable legs as two field arrays, live invariant sum |
| 3d | `CashSettlementDialog`, owed-expense form, `NoteDialog` | | Smaller; consistency |

Server `Invalid { field }` errors get mapped back onto the matching form field.

Watch: bundle size. Importing `effect/Schema` into client components adds weight (v4 tree-shakes far better than v3, but measure). Measure `next build` route sizes before and after 3a. If the increase is too large, keep pure validators shared and use Schema only on the server.

## Phase 4: TanStack Table for bulk review (2 PRs)

Dependency: `@tanstack/react-table` (headless; existing Tailwind markup stays).

- **4a, server first:** a new `setCategoryForTransactions({ ids, categoryId })` action via `defineAction`, using `assertTransactionsOwned` + `assertCategoryOwned`, with a capped id count (e.g. 500) and one SQL update that also sets `isTransfer` exactly as `setTransactionCategory` does. Same for bulk `needsReview`.
- **4b, `/review` page:** a client table island with row selection, a "select all on page" control, and a sticky bulk bar (category select + mark reviewed). Data still loads on the server (`load-table-context.ts`); the table uses `manualPagination` / `manualSorting`. Sorting changes the URL and the server re-queries, so full-filter totals stay correct.
- Later, `/transactions` reuses the same table component.

## Phase 5: TanStack Query for on-demand reads (1 PR)

Dependency: `@tanstack/react-query`.

- `QueryClientProvider` in `SessionProvider`. **Tenant safety:** create the client per session and `queryClient.clear()` on sign-out, keying queries by `user.id`.
- Convert: `LinkedTransactionLink` preview, `NoteDialog` candidates, `CategoryAccordion` (`getCategoryTransactions`). Each `queryFn` calls the Phase 2 read action and unwraps `ActionResult`.
- Mutations invalidate the affected keys alongside the existing `revalidatePath`.

## Phase 6 (optional): Pacer, then re-evaluate DB

- `@tanstack/react-pacer`: debounced live search that writes `?q=` to the URL. Only if live search is wanted; today it's a submit form.
- Re-run `docs/tanstack-db-assessment.md` once Table + Query exist on `/review`. That's when DB's shared reactive views would actually have consumers.

---

## Directions that can run in parallel

```
Phase 0 ─► Phase 1 ─┬─► 2a ─► 3a ─► 3b ─► 3c
                    ├─► 2b ────────────┘
                    ├─► 2c, 2e, 2f, 2g (independent)
                    └─► 2d ─┬─► 4a ─► 4b
                            └─► 5
```

- **Track A (correctness):** Phases 1 → 2. Blocks everything else.
- **Track B (forms):** 3a can start as soon as 2a lands.
- **Track C (review UX):** 4a needs only Phase 1; 4b needs 2d.
- **Track D (reads):** 5 needs 2d.

## Risks

| Risk | Mitigation |
|---|---|
| Effect learning curve / boilerplate | All of it lives in `define-action.ts`; handlers read as `Effect.gen` with `yield*`. Pilot on 2a before committing to the rest. |
| `"use server"` export shape | Checked in Phase 1 (see open check). |
| Silent loss of an auth check during migration | `defineAction` provides `CurrentUser` only via a layer that fails closed; the grep check blocks bare exports; each PR's review checks the ownership asserts line by line against the old code. |
| Client bundle growth from Schema | Measured at 3a; fallback described there. |
| Vercel preview builds fail on PRs | Known env-var issue, not caused by this work. Verify locally with `next build`. |
| Financial invariants (split totals, capacity, tx ordering) | No validator logic changes in Phase 2: wrap, don't rewrite. Existing `validate.test.ts` suites must stay green. |

## Verification per PR

`pnpm typecheck`, `bun test`, `next build`, plus a manual pass of the touched flow on the local-dev Neon branch. Include a prod-mode (`next start`) check for at least one expected error.
