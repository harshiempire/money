# UI/UX Refresh — Executor Plan (for Composer / small agents)

This is the **step-by-step execution spec** for the four-phase UI refresh. It was written
after auditing the repo at `main` (`418db39`). Follow it in order, phase by phase, and do
not improvise beyond what each step says. All facts below (file paths, line behavior,
type shapes, identities) were verified against the actual code — trust them.

> **Read [AGENTS.md](../AGENTS.md) first.** Its rules (auth, tenancy, never touching
> `src/domain` math, server actions) apply throughout. This refresh is presentation-only.

---

## 0. Ground truth — read before starting

### 0.1 Phase 1 is NOT done on `main`

Despite earlier hand-off notes, **no phase of this plan has landed on `main`**:

- `src/app/globals.css` on `main` is 9 lines — no `@theme` tokens, no `@custom-variant`.
- There is no `src/components/ui/` directory on `main`.
- Two stale PRs exist — **#5** (`cursor/ui-refinement-cbff`) and **#6**
  (`cursor/ui-revamp-da2c`). Both predate `main`'s monthly-parser commit (`8ab4c1c`),
  both skipped ahead to a sidebar shell, neither implements the agreed token names
  (`--color-spend` / `--color-inflow` / `--color-owed-to-me` / `--color-i-owe`), neither
  adds the `data-theme` dark variant, and #6 moved all pages into an `(app)` route group
  — which this plan explicitly rejects.

**Rule: implement everything fresh from `main`.** You may *read* those two branches for
component inspiration (`git show origin/cursor/ui-revamp-da2c:src/components/ui/Money.tsx`
etc.), but do not merge, rebase onto, or cherry-pick from them. Recommend to the user
that PRs #5 and #6 be closed as superseded.

### 0.2 Toolchain facts (verified)

- Runtime/PM: **Bun** (`bun install`, `bun run ...`, `bun test`). Tailwind **v4.3**
  via `@tailwindcss/postcss`. Next.js **16**, React 19, TypeScript 6.
- ✅ `bun run typecheck` passes on `main`. This is your primary gate.
- ❌ `bun run lint` is **already broken on `main`**: the script is `next lint`, which was
  removed in Next 16 (it errors with "Invalid project directory provided ... /workspace/lint"),
  and there is no ESLint config file in the repo. **Do not try to fix lint as part of this
  work** unless the user asks; use `bun run typecheck` + `bun run build` + `bun test` as gates.
- `bun test` runs 2 existing test files (`src/lib/net-events/validate.test.ts`,
  `src/lib/people/match-counterparty.test.ts`). Keep them green.
- Running the app needs `DATABASE_URL` + `AUTH_SECRET` (see `.env.example`) and a login.
  All protected pages redirect to `/login` when signed out.

### 0.3 Pages and their current chrome (verified inventory)

Every protected page hand-rolls the same chrome. You will touch exactly these 9 files in
Phase 3; in Phases 1–2 you only touch the four marked ★.

| Route | File | `<h1>` title | `max-w` | Notes |
|---|---|---|---|---|
| `/` ★ | `src/app/page.tsx` | Money | `max-w-5xl` | hero, triage, breakdown card, category bars, local `PeriodDelta` + `PeriodPicker` |
| `/spend` ★ | `src/app/spend/page.tsx` | Spend report | `max-w-5xl` | hero, breakdown, daily chart, monthly-history `<table>`, duplicate local `PeriodDelta` |
| `/transactions` | `src/app/transactions/page.tsx` | Transactions | `max-w-6xl` | `<ScrollToTransaction>` sits above `<header>`; `AutoDetectButton` below it |
| `/review` | `src/app/review/page.tsx` | Review later | `max-w-6xl` | |
| `/timeline` | `src/app/timeline/page.tsx` | Timeline | `max-w-5xl` | |
| `/reimbursements` | `src/app/reimbursements/page.tsx` | Reimbursements | `max-w-5xl` | |
| `/people` ★ | `src/app/people/page.tsx` | People | `max-w-5xl` | balances `<table>` |
| `/people/[id]` | `src/app/people/[id]/page.tsx` | `{detail.personName}` (dynamic) | `max-w-5xl` | nav `current="/people"` |
| `/import` | `src/app/import/page.tsx` | Import statement | `max-w-2xl` | |

★ also touched in Phase 1. `/login`, `/register`, `/api/*` are **never** touched.

`src/components/spend/SpendBreakdown.tsx` ★ is rendered by `/` (with `compact`) and
`/spend` (full).

### 0.4 The tone-color strings you are replacing

These exact class pairs are copy-pasted across the app (current counts on `main`):

| Literal string | Meaning | Token utility after Phase 1 | Occurrences (files) |
|---|---|---|---|
| `text-red-700 dark:text-red-400` | spend / debit | `text-spend` | page, spend, SpendBreakdown, transactions, TransactionTable, timeline, NoteDialog, … |
| `text-emerald-700 dark:text-emerald-400` | inflow / credit | `text-inflow` | same spread |
| `text-amber-700 dark:text-amber-400` | owed to me | `text-owed-to-me` | spend, people, SplitAwaitingItem, TransactionTable, … |
| `text-sky-700 dark:text-sky-400` | I owe | `text-i-owe` | spend, people, … |

13 `.tsx` files contain at least one of these (≈52 occurrences total). Verify your sweep with:

```bash
rg -n "text-red-700 dark:text-red-400|text-emerald-700 dark:text-emerald-400|text-amber-700 dark:text-amber-400|text-sky-700 dark:text-sky-400" src
```

→ must return **zero** matches after Phase 1 (other shades like `text-amber-800`,
`bg-amber-50/60`, `fill-red-500/60` are intentionally out of scope — leave them).

### 0.5 The net-spend math you must reconcile against (Phase 2)

From `src/domain/spend/net.ts` and `src/domain/spend/reimbursements.ts` (verified):

```ts
// net.ts:328
interface SplitBridgeTotals {
  personalDebitGrossPaise: number;
  yourShareDebitPaise: number;
  othersSharePaise: number;   // == personalDebitGrossPaise - yourShareDebitPaise (exact, by construction)
  netCreditPaise: number;
  splitTxnCount: number;
}

// net.ts:37
interface NetSpendTotals {
  totalDebitPaise: number;
  totalCreditPaise: number;
  netSelfPaise: number;       // == txnNetSelf + owedSelfPaise   ← !!
  owedSelfPaise: number;      // shared expenses OTHERS paid, your share
  count: number;
}

// reimbursements.ts:9
interface ReimbursementBridgeTotals {
  expectedReimbursePaise: number;
  settledReimbursePaise: number;
  outstandingReimbursePaise: number;
  outstandingPayablePaise: number;
  receivedInPeriodPaise: number;
  splitCount: number;
  openSplitCount: number;
}
```

**Critical identity** (this is the trap):

```
netSelfPaise = yourShareDebitPaise − netCreditPaise + owedSelfPaise
```

The existing `<dl>` in `SpendBreakdown.tsx` silently ignores `owedSelfPaise`, so its rows
only sum exactly when `owedSelfPaise == 0`. The waterfall **must include an
`owedSelfPaise` step** (when > 0) or its bars will not reconcile. Both call sites already
have `totals.owedSelfPaise` in scope — you only need to thread it through as a prop.

### 0.6 Global guardrails (apply to every phase)

- **No new runtime dependencies.** Icons and charts are inline SVG. Do not `bun add` anything.
- **Do not touch:** `src/domain/**`, `src/db/**`, `src/lib/**` (except *adding* to
  `src/lib/format.ts` + its new test in Phase 4), any `actions.ts` / `*-actions.ts`,
  `src/auth.ts`, `middleware.ts`, `src/instrumentation.ts`, `drizzle/**`, `scripts/**`.
- **Do not move route folders** (no route groups). `/login`, `/register`, `src/app/api`
  stay untouched.
- New shared components must be **server-safe** (no `"use client"`) unless they genuinely
  need state (`AppShell`, `ThemeToggle`, `InfoPopover` do; `Money`, `StatHero`,
  `SectionCard`, `Bar`, `PeriodDelta`, `SpendWaterfall`, `Skeleton` must not).
- Inside `<svg>`, only use `formatPaisePlain` (never `formatPaise` — `Intl` output differs
  between server and client and causes hydration mismatches; this convention already
  exists in `DailySpendChart.tsx`).
- The minus sign used across the app is **U+2212 `−`**, not ASCII `-`. Keep it.
- One commit per phase minimum; run the phase's verification before committing.

---

## Phase 1 — Design-token foundation

**Outcome:** semantic color tokens + 5 shared components; 4 files refactored to use them;
app renders pixel-identical in light and dark.

### 1a. Rewrite `src/app/globals.css`

Replace the entire file with exactly this (values are Tailwind v4.3's own `red-700`,
`red-400`, etc., copied from `node_modules/tailwindcss/theme.css`, so nothing shifts
visually):

```css
@import "tailwindcss";

/*
 * Dark mode = explicit user choice via data-theme on <html> (set by the Phase-4
 * toggle), falling back to the OS preference when no choice is stored.
 * `dark:*` utilities everywhere in the app keep working unchanged.
 */
@custom-variant dark {
  &:where([data-theme="dark"], [data-theme="dark"] *) {
    @slot;
  }
  @media (prefers-color-scheme: dark) {
    &:where(:not([data-theme="light"]):not([data-theme="light"] *)) {
      @slot;
    }
  }
}

/*
 * Semantic tone tokens. Each generates utilities (text-spend, bg-inflow/10,
 * border-owed-to-me, fill-spend, ...) that flip automatically with the theme —
 * no dark: prefix needed at call sites.
 */
@theme {
  --color-spend: oklch(50.5% 0.213 27.518); /* red-700 */
  --color-inflow: oklch(50.8% 0.118 165.612); /* emerald-700 */
  --color-owed-to-me: oklch(55.5% 0.163 48.998); /* amber-700 */
  --color-i-owe: oklch(50% 0.134 242.749); /* sky-700 */
  --color-split: oklch(49.1% 0.27 292.581); /* violet-700 */
}

:root[data-theme="dark"] {
  --color-spend: oklch(70.4% 0.191 22.216); /* red-400 */
  --color-inflow: oklch(76.5% 0.177 163.223); /* emerald-400 */
  --color-owed-to-me: oklch(82.8% 0.189 84.429); /* amber-400 */
  --color-i-owe: oklch(74.6% 0.16 232.661); /* sky-400 */
  --color-split: oklch(70.2% 0.183 293.541); /* violet-400 */
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-spend: oklch(70.4% 0.191 22.216);
    --color-inflow: oklch(76.5% 0.177 163.223);
    --color-owed-to-me: oklch(82.8% 0.189 84.429);
    --color-i-owe: oklch(74.6% 0.16 232.661);
    --color-split: oklch(70.2% 0.183 293.541);
  }
}

:root {
  color-scheme: light dark;
}

body {
  font-family: ui-sans-serif, system-ui, sans-serif;
}
```

Notes:
- This exact CSS was compile-verified against the repo's Tailwind 4.3: `text-spend`,
  `bg-inflow/10`, `border-owed-to-me`, `fill-spend/80` all generate, and `dark:*`
  utilities emit both the `[data-theme="dark"]` rule and the
  `prefers-color-scheme` fallback. Copy it verbatim.
- The dark values are duplicated on purpose (attribute selector + media-query fallback);
  do not "simplify" it away — that duplication is what makes the Phase-4 toggle work
  without any JS in Phase 1.
- Do NOT add fonts, shadows, radii, scrollbar styling, or surface-color tokens. That was
  the scope creep that sank PRs #5/#6. Neutral grays stay as `neutral-*` utilities.

**Smoke-test the variant** before proceeding: run the dev server, open any page, and in
DevTools set `<html data-theme="dark">` then `data-theme="light"` — the whole UI must
flip regardless of OS setting. Remove the attribute → follows OS again.

### 1b. Create `src/components/ui/`

Five files. Reference implementations below — keep the class strings **exactly** as
shown (they are lifted verbatim from the call sites being replaced).

**`src/components/ui/Money.tsx`** (server-safe)

```tsx
import { formatPaise, formatPaisePlain } from "@/lib/format";

export type MoneyTone =
  | "spend"
  | "inflow"
  | "owed-to-me"
  | "i-owe"
  | "neutral"
  | "muted"
  | "auto";

const TONE_CLASS: Record<Exclude<MoneyTone, "auto">, string> = {
  spend: "text-spend",
  inflow: "text-inflow",
  "owed-to-me": "text-owed-to-me",
  "i-owe": "text-i-owe",
  neutral: "",
  muted: "text-neutral-500",
};

/**
 * Inline paise amount. tone="auto" colors by sign (>= 0 spend, < 0 inflow) —
 * matching the BridgeRow convention. `signed` prefixes − for negatives and
 * renders the absolute value (the app-wide display convention).
 */
export function Money({
  value,
  tone = "neutral",
  signed = false,
  plain = false,
  className = "",
}: {
  value: number | null | undefined;
  tone?: MoneyTone;
  signed?: boolean;
  /** Use formatPaisePlain (deterministic, SSR-safe — required inside SVG). */
  plain?: boolean;
  className?: string;
}) {
  const resolvedTone =
    tone === "auto" ? ((value ?? 0) >= 0 ? "spend" : "inflow") : tone;
  const fmt = plain ? formatPaisePlain : formatPaise;
  const display =
    value == null
      ? fmt(value)
      : signed
        ? `${value < 0 ? "−" : ""}${fmt(Math.abs(value))}`
        : fmt(value);
  return (
    <span
      className={`font-mono whitespace-nowrap ${TONE_CLASS[resolvedTone]} ${className}`.trim()}
    >
      {display}
    </span>
  );
}
```

**`src/components/ui/StatHero.tsx`** (server-safe) — replaces the `text-5xl` hero block
duplicated at `page.tsx:121` and `spend/page.tsx:106`:

```tsx
import { formatPaise } from "@/lib/format";

export function StatHero({
  label,
  valuePaise,
  tone,
  suffix,
  children,
}: {
  label: React.ReactNode;
  valuePaise: number;
  /** Resolved by caller; dashboards use netSelfPaise >= 0 ? "spend" : "inflow". */
  tone: "spend" | "inflow";
  /** e.g. the "(net inflow)" tag on the dashboard. */
  suffix?: React.ReactNode;
  /** Meta row below the number (delta, burn rate, counts, links). */
  children?: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div
        className={`mt-1 font-mono text-5xl ${tone === "spend" ? "text-spend" : "text-inflow"}`}
      >
        {formatPaise(Math.abs(valuePaise))}
        {suffix}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
        {children}
      </div>
    </section>
  );
}
```

**`src/components/ui/SectionCard.tsx`** (server-safe) — the repeated
`rounded border border-neutral-200 p-4 dark:border-neutral-800` card:

```tsx
export function SectionCard({
  title,
  action,
  className = "",
  children,
}: {
  title?: React.ReactNode;
  /** Right-aligned affordance, e.g. the "Full report →" link. */
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded border border-neutral-200 p-4 dark:border-neutral-800 ${className}`.trim()}
    >
      {(title || action) && (
        <div className="flex items-baseline justify-between gap-3">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      <div className={title || action ? "mt-3" : ""}>{children}</div>
    </section>
  );
}
```

**`src/components/ui/Bar.tsx`** (server-safe) — the category progress bar from
`page.tsx:248`. Keep the exact `red-500/70` fill (it is intentionally lighter than the
text tone; changing it to `bg-spend/70` would visibly darken light mode):

```tsx
export function Bar({
  value,
  max,
  className = "",
}: {
  value: number;
  max: number;
  className?: string;
}) {
  const width = Math.max(2, (value / Math.max(1, max)) * 100).toFixed(1);
  return (
    <div
      className={`h-1.5 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800 ${className}`.trim()}
    >
      <div
        className="h-full bg-red-500/70 dark:bg-red-400/70"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
```

**`src/components/ui/PeriodDelta.tsx`** (server-safe) — promote the *identical* private
component currently defined twice (`page.tsx:357` and `spend/page.tsx:313`). Copy the
body verbatim, swapping the two tone class pairs for `text-spend` / `text-inflow`,
and `export function PeriodDelta`.

### 1c. Refactor the four ★ files

Behavior-preserving only. For each file: import the new components, delete the local
duplicates, replace inline class pairs.

1. **`src/app/page.tsx`**
   - Delete the local `PeriodDelta` (lines 357–386); import from `@/components/ui/PeriodDelta`.
   - Hero section (lines 121–156) → `<StatHero label={...} valuePaise={totals.netSelfPaise} tone={totals.netSelfPaise >= 0 ? "spend" : "inflow"} suffix={...}>` with the delta/burn/count spans as children. Keep the "(net inflow)" suffix span, retoned to `text-inflow`.
   - "Spend breakdown" section (lines 190–209) → `<SectionCard title="Spend breakdown" action={<a …>Full report →</a>} className="mt-8">`.
   - Category bar `<div>` (lines 248–255) → `<Bar value={c.netSelfPaise} max={maxSpend} className="mt-1" />`.
   - Sweep remaining tone pairs (e.g. "Inflows reducing net" heading/amounts → `text-inflow`).
   - Leave `PeriodPicker`, triage section, and all data loading **untouched**.
2. **`src/app/spend/page.tsx`** — same treatment: delete local `PeriodDelta`, hero →
   `StatHero` (children include the reimbursement links — retone to `text-owed-to-me` /
   `text-i-owe`), the two `SectionCard`-shaped sections ("Spend breakdown", "Daily spend"),
   sweep tone pairs incl. the monthly-history "Still owed" cells (`text-owed-to-me`) and
   "Biggest expenses" amounts (`text-spend`, or `<Money tone="spend" …/>`).
3. **`src/components/spend/SpendBreakdown.tsx`** — in `BridgeRow`, replace the two tone
   class pairs with `text-spend` / `text-inflow`; replace `ReimbursementSection` tone
   pairs (`text-emerald-…` → `text-inflow`, `text-amber-700 dark:text-amber-400` →
   `text-owed-to-me`; `text-amber-800 dark:text-amber-300` stays). Optionally render the
   `dd` via `<Money signed tone={...}>`. No structural change in Phase 1.
4. **`src/app/people/page.tsx`** — table cells → `text-owed-to-me` / `text-i-owe`
   (or `<Money>` with those tones).

Then do the **mechanical sweep** over the remaining 9 files from §0.4 (transactions
page/table/dialogs, timeline, reimbursements, people/[id]): pure string substitution of
the four class pairs to their token utilities. Nothing else in those files.

### Phase 1 verification

- ✅ `bun run typecheck` · ✅ `bun run build` · ✅ `bun test`
- The §0.4 `rg` command returns zero matches; `rg -n "function PeriodDelta" src` returns
  only `src/components/ui/PeriodDelta.tsx`.
- Dev-server walk of all 9 routes, light + dark (toggle via the `data-theme` DevTools
  trick **and** via OS emulation), desktop + 390 px. Amounts, colors, and layout must be
  indistinguishable from `main`.
- Commit: `feat(ui): design tokens + shared Money/StatHero/SectionCard/Bar/PeriodDelta`.

---

## Phase 2 — Net-spend waterfall

**Outcome:** `src/components/spend/SpendWaterfall.tsx` (inline SVG, server-safe) rendered
above the `<dl>` inside `SpendBreakdown`, on both `/` (compact) and `/spend` (full).

### 2a. Thread `owedSelfPaise` through (presentation-only prop)

- `SpendBreakdown` gains an optional prop `owedSelfPaise?: number` (default 0).
- `src/app/page.tsx` and `src/app/spend/page.tsx` pass `owedSelfPaise={totals.owedSelfPaise}`.
- Both pages already have `totals` in scope — **no data-layer changes**.

### 2b. Build the steps model

```ts
type WaterfallStep = {
  key: string;
  label: string;           // short — drawn under the axis
  value: number;           // paise; bar magnitude
  kind: "anchor" | "delta" | "total"; // anchor = full bar from 0; delta = floating
  tone: "spend" | "inflow" | "owed-to-me" | "neutral";
};
```

Steps, in order (skip any `delta` whose value is 0):

| key | label | value | kind | tone |
|---|---|---|---|---|
| gross | `Gross debits` | `bridge.personalDebitGrossPaise` | anchor | neutral (use `fill-neutral-400/70 dark:fill-neutral-500/70`) |
| others | `For others` | `−bridge.othersSharePaise` | delta | inflow |
| share | `Your share` | `bridge.yourShareDebitPaise` | anchor | spend |
| owed | `Others paid` | `+owedSelfPaise` | delta | owed-to-me |
| refunds | `Refunds` | `−bridge.netCreditPaise` | delta | inflow |
| net | `Net spend` | `netSelfPaise` | anchor | spend if ≥ 0 else inflow |

**Invariants — assert these mentally and verify on screen:**
`gross − othersShare == share` and `share + owedSelf − netCredit == net` (see §0.5).
The running level after applying each delta MUST land exactly on the next anchor's value.
If your bars don't line up, you mis-ordered or dropped a step — do not "fix" it by
fudging coordinates.

Guard clause (mirror `SpendBreakdown.tsx:16`): render `null` when
`bridge.personalDebitGrossPaise <= 0 && bridge.netCreditPaise <= 0`.

### 2c. Geometry (deterministic, no hooks, no Intl)

Follow `DailySpendChart.tsx` conventions: fixed `viewBox`, `svgCoord` rounding to 1
decimal, `<title>` tooltips, `formatPaisePlain` for every number inside the SVG.

```
W = 800, H = compact ? 180 : 220
PAD_TOP = 18 (room for value labels), PAD_BOTTOM = 22 (step labels), PAD_X = 8
innerH = H - PAD_TOP - PAD_BOTTOM
maxLevel = max(personalDebitGrossPaise, yourShareDebitPaise + owedSelfPaise, |netSelfPaise|, 1)
scale = innerH / maxLevel
yOf(level) = PAD_TOP + innerH - level * scale

n columns = steps.length; colW = (W - 2*PAD_X) / n; bar width = colW * 0.6, centered.
Track running `level` (start 0):
  anchor → bar from yOf(value) to yOf(0); level = value
  delta  → bar between yOf(level) and yOf(level + value); level += value
Negative final net (net inflow): the net anchor draws from yOf(0) down is impossible in
this coordinate system — instead draw it as a bar from yOf(|net|) to yOf(0) in inflow
tone and append " (net inflow)" to its <title>. Keep it simple; do not invent a
below-axis region.
Connectors: dashed line (strokeDasharray="3 3", stroke-neutral-400/60) from the right
edge of each bar to the left edge of the next, at y = yOf(level at that boundary).
Value labels: formatPaisePlain at the top edge of each bar (fontSize 10,
fill-neutral-600 dark:fill-neutral-300); use the signed value for deltas (−/+, U+2212).
Step labels: under the axis, fontSize 9, textAnchor middle.
Tones: fill via token utilities — fill-spend/80, fill-inflow/80, fill-owed-to-me/80.
<title> per bar: `${label} · ${formatPaisePlain(value)}`.
Wrapper: <svg viewBox=... className="w-full" role="img" aria-label="Net spend waterfall">.
```

Optional (only if everything above reconciles): when
`reimbursement.outstandingReimbursePaise > 0`, draw one dashed horizontal segment across
the **net** column at `yOf(netSelfPaise − outstandingReimbursePaise)` with
`<title>If everyone pays you back · {formatPaisePlain(netSelfPaise − outstandingReimbursePaise)}</title>`.

### 2d. Integrate

In `SpendBreakdown.tsx`, render `<SpendWaterfall …/>` as the first child in **both** the
compact and full branches, passing `bridge`, `netSelfPaise`, `owedSelfPaise`,
`reimbursement`, `compact`. The `<dl>`s stay exactly as they are (they are the precise
numeric fallback).

### Phase 2 verification

- ✅ `bun run typecheck` · ✅ `bun run build` · ✅ `bun test`
- On `/spend`: every waterfall number equals the corresponding `<dl>` row; the bars
  visually "step down" with no gaps (the reconciliation identity made visible).
- Pick a period with splits AND one with `owedSelfPaise > 0` if data allows; also verify
  an empty period renders no waterfall and no crash.
- Browser console: **zero hydration warnings** on `/` and `/spend`.
- Commit: `feat(spend): net-spend waterfall (SVG) above breakdown dl`.

---

## Phase 3 — Navigation + layout (AppShell)

**Outcome:** one `AppShell` client component owning sidebar (desktop) / bottom tabs
(mobile) + the content column + page header; 9 pages migrated; `AppNav.tsx` deleted.

### 3a. `src/components/icons.tsx`

~10 small inline-SVG icon components, all this shape (24×24, `stroke="currentColor"`,
`strokeWidth={1.8}`, `fill="none"`, `strokeLinecap="round"`, `strokeLinejoin="round"`,
accept `className`): `IconHome`, `IconChart` (spend), `IconList` (transactions),
`IconFlag` (review), `IconClock` (timeline), `IconSwap` (reimbursements), `IconUsers`
(people), `IconUpload` (import), `IconMore` (ellipsis), `IconX`. Draw simple geometric
paths; e.g.:

```tsx
export function IconHome({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </svg>
  );
}
```

### 3b. `src/components/AppShell.tsx` (`"use client"`)

Nav model (single source of truth inside this file):

```ts
const NAV_GROUPS = [
  { label: "Overview", items: [{ href: "/", label: "Dashboard", icon: IconHome }] },
  { label: "Money", items: [
    { href: "/spend", label: "Spend", icon: IconChart },
    { href: "/transactions", label: "Transactions", icon: IconList },
    { href: "/review", label: "Review", icon: IconFlag },
    { href: "/timeline", label: "Timeline", icon: IconClock },
  ]},
  { label: "Settle", items: [
    { href: "/reimbursements", label: "Reimbursements", icon: IconSwap },
    { href: "/people", label: "People", icon: IconUsers },
  ]},
  { label: "Data", items: [{ href: "/import", label: "Import", icon: IconUpload }] },
];
```

Props:

```ts
{
  title: React.ReactNode;
  width?: "default" | "wide" | "narrow"; // max-w-5xl | max-w-6xl | max-w-2xl
  actions?: React.ReactNode;             // right side of the header row
  children: React.ReactNode;
}
```

Active state via `usePathname()` (`import { usePathname } from "next/navigation"`):
`href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/")`
(so `/people/[id]` highlights People).

Layout:

- **Desktop (`md:` up):** flex row. Sidebar: `hidden md:flex md:w-56 md:flex-col`,
  `sticky top-0 h-screen`, right border `border-neutral-200 dark:border-neutral-800`,
  brand "Money" at top (`text-lg font-semibold`, links to `/`), groups with
  `text-[10px] uppercase tracking-wide text-neutral-500` labels, items as
  `flex items-center gap-2 rounded px-2 py-1.5 text-sm` — active:
  `bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100`;
  inactive: `text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800`.
  Footer (mt-auto): `<SignOutButton />` (+ `<ThemeToggle />` in Phase 4).
- **Content:** `flex-1 min-w-0`; inner `mx-auto p-8 pb-24 md:pb-8` + width class;
  header row `flex items-baseline justify-between gap-3`:
  `<h1 className="text-2xl font-semibold">{title}</h1>` and `{actions}`.
- **Mobile (`md:hidden`):** fixed bottom tab bar
  (`fixed inset-x-0 bottom-0 z-30 border-t bg-white dark:bg-neutral-950
  border-neutral-200 dark:border-neutral-800 pb-[env(safe-area-inset-bottom)]`),
  5 tabs: Dashboard, Spend, Transactions, Reimbursements (label "Settle"), **More**.
  Tabs: icon (h-5 w-5) over 10px label, active `text-neutral-900 dark:text-neutral-100`,
  inactive `text-neutral-500`. "More" toggles a sheet (simple `useState`, panel above the
  bar: Review, Timeline, People, Import, divider, SignOutButton; backdrop button closes;
  close on any link tap). No portals/animation libs.
- Use plain `<a>` links (the pages are `force-dynamic` server pages and the rest of the
  app uses `<a>`; do not introduce `next/link` churn in this pass).

### 3c. Migrate the 9 pages

For each page in §0.3: replace `<main className="mx-auto max-w-… p-8">` +
`<header>…<AppNav…/></header>` with `<AppShell title="…" width="…">` and delete the
`AppNav` import. Width: `wide` for transactions + review, `narrow` for import, default
otherwise. Specifics:

- `/transactions`: keep `<ScrollToTransaction …/>` as the first child *inside*
  `AppShell`; pass `actions={<AutoDetectButton />}` (it currently sits in the row under
  the header — moving it to `actions` is the intended cleanup; keep the "Account: …"
  paragraph as first content child).
- `/people/[id]`: `title={detail.personName}`.
- Everything else: title strings from the §0.3 table; all body content unchanged.

Then **delete `src/components/AppNav.tsx`** and verify:
`rg -n "AppNav" src` → zero matches. `SignOutButton` usage moves into the shell only.

### Phase 3 verification

- ✅ `bun run typecheck` · ✅ `bun run build` · ✅ `bun test`
- Walk all 9 routes at ≥1280 px (sidebar, correct group/item highlighted — including
  `/people/[id]` → People) and at 390 px (bottom tabs, More sheet opens/closes, content
  not hidden behind the bar). `/login` and `/register` unchanged (no sidebar).
- Commit: `feat(nav): AppShell sidebar + mobile bottom tabs; retire AppNav`.

---

## Phase 4 — Mobile + polish

Four independent sub-tasks; commit each separately.

### 4a. Responsive tables → stacked cards (below `md`)

Pattern for all three: keep the existing `<table>` wrapped in `hidden md:block`
(replacing `overflow-x-auto` wrappers with `hidden md:block overflow-x-auto`), and add a
`md:hidden space-y-2` sibling list rendering the same row data as cards
(`rounded border border-neutral-200 p-3 dark:border-neutral-800`). Same data, same
components, no logic changes.

1. `src/app/transactions/TransactionTable.tsx` — card layout: row 1 = date (mono xs,
   muted) + `<ChannelPill>` left, amount right (existing tone logic); row 2 = counterparty
   (medium) + purpose/note/links lines (reuse the exact td contents); row 3 =
   `<RowActions …/>` (pass identical props) + balance right (mono xs muted). Preserve the
   `id={`txn-${r.id}`}` anchor and the needs-review / linked left-border treatment on the
   card. Keep `<SplitSettlementLinks>` / `<SplitSettlementStatusLine>` inside row 2.
2. `src/app/spend/page.tsx` monthly-history table — card: month link + "(partial)" badge,
   then a 2×2 grid of label/value pairs (Net, Your share, Fronted, Still owed) using the
   same tone classes; highlight current month with `bg-neutral-50 dark:bg-neutral-900/40`.
3. `src/app/people/page.tsx` — card: person link + counts line, then They owe me /
   I owe them / Net with existing tones.

### 4b. Theme toggle (light / dark / system)

1. `src/app/layout.tsx` — add a no-flash script as the first child of `<body>` (Next 16
   App Router has no `<head>` children API for this; an inline script at the top of body
   runs before paint of the content below):

```tsx
<script
  dangerouslySetInnerHTML={{
    __html:
      '(function(){try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()',
  }}
/>
```

2. `src/components/ThemeToggle.tsx` (`"use client"`): three-state segmented control
   (Light / System / Dark, or a single cycling button with icon + label). On change:
   `localStorage.setItem("theme", v)` for explicit choices /
   `localStorage.removeItem("theme")` for system, and set/remove `data-theme` on
   `document.documentElement` accordingly. Initialize state from `localStorage` in a
   `useEffect` (render "system" on the server; no `next-themes`, no context).
3. Mount in `AppShell`: sidebar footer + the mobile More sheet.
4. CSS already supports this from Phase 1 — no CSS changes.

Verify: pick Dark with OS light → stays dark after reload with **no flash**; System
follows OS; choice persists across all routes.

### 4c. `InfoPopover` — tame the prose

`src/components/ui/InfoPopover.tsx` (`"use client"`): a `(?)` trigger button
(`rounded-full border border-neutral-300 dark:border-neutral-700 h-4 w-4 text-[10px]
text-neutral-500 leading-none`, `aria-label="Explain"`), popover panel
(`absolute z-20 mt-1 w-64 rounded border border-neutral-200 bg-white p-3 text-xs
text-neutral-600 shadow-lg dark:border-neutral-800 dark:bg-neutral-950
dark:text-neutral-400`) toggled by `useState`, closed on outside click (document listener
in `useEffect`) and Escape. Container `relative inline-block`.

Move into popovers (keep the copy verbatim — the honesty is a feature):
- `SpendBreakdown.tsx` full mode: the three explanatory `<p>`s — "Money that left your
  bank…", "What others owe…", "Your true spend after refunds…" — each becomes an
  `<InfoPopover>` next to its section heading.
- `/spend` subtitle "What you actually spent…" and `/people` subtitle "All-time
  balances…" may stay — they're one-liners. Do not popover-ize anything else.

### 4d. Skeletons + first-import CTA

- `src/components/ui/Skeleton.tsx` (server-safe):
  `<div className={"animate-pulse rounded bg-neutral-100 dark:bg-neutral-800 " + className} />`.
- Add `loading.tsx` for `/`, `/spend`, `/transactions`, `/reimbursements`, `/timeline`,
  `/people`, `/review`: each renders `<AppShell title="…">` (static title) with 3–5
  skeleton blocks shaped like that page (hero line `h-12 w-64`, card `h-40`, list rows
  `h-5`). ~15 lines each; no data fetching.
- Dashboard empty state: in `src/app/page.tsx`, when `totals.count === 0 && cats.length === 0`,
  render (instead of the breakdown/category sections) a `SectionCard` CTA: "No
  transactions yet" + one-line explanation + a prominent link to `/import`
  (`inline-block rounded bg-neutral-900 px-3 py-1.5 text-sm text-white
  dark:bg-neutral-100 dark:text-neutral-900`). The existing "Nothing categorized yet"
  copy stays for the non-empty-but-untagged case.

### 4e. `formatPaiseShort`

Add to `src/lib/format.ts` (deterministic, no `Intl` — SVG-safe), Indian units:

```
< ₹1,000        → "₹950"          (integer rupees)
< ₹1,00,000     → "₹1.2k"  (thousands, 1 decimal)
< ₹1,00,00,000  → "₹3.4L"  (lakhs, 1 decimal)
else            → "₹1.2Cr" (crores, 1 decimal)
Strip trailing ".0"; negatives prefixed with U+2212 "−"; null/undefined → "—".
```

Test vectors for `src/lib/format.test.ts` (bun test, mirror the style of
`src/lib/net-events/validate.test.ts`): `0 → "₹0"`, `95000 → "₹950"`, `100000 → "₹1k"`,
`123456 → "₹1.2k"`, `9999900 → "₹100k"` (₹99,999 rounds up at 1 decimal — acceptable),
`10000000 → "₹1L"`, `34000000 → "₹3.4L"`,
`1000000000 → "₹1Cr"`, `-123456 → "−₹1.2k"`, `null → "—"`.

Use it in `SpendWaterfall` value labels **only when `compact`** (full report keeps exact
`formatPaisePlain` labels). No other call sites.

### Phase 4 verification

- ✅ `bun run typecheck` · ✅ `bun run build` · ✅ `bun test` (now includes format tests)
- 390 px: transactions/people/monthly-history render as cards (no sideways scroll);
  dialogs opened from a card still work (split/settle/note).
- Theme: all three states, reload persistence, no flash, every route.
- Throttle network (DevTools "Slow 4G") → skeletons appear on route change.
- Empty-tenant check: register a fresh user → dashboard shows the import CTA.

---

## Final hand-off checklist

- [ ] Four phases on one branch with one commit (or more) per phase, or four stacked PRs
      — match whatever the user asked for in the session.
- [ ] `rg` guards pass: no `text-red-700 dark:text-red-400`-style pairs, no `AppNav`,
      single `PeriodDelta`.
- [ ] `git diff main --stat` contains **no** files under `src/domain`, `src/db`,
      `drizzle/`, `scripts/`, no `actions.ts`, and no changes to `src/lib/` other than
      `format.ts` + `format.test.ts`.
- [ ] Screenshots (light + dark, desktop + mobile) of `/`, `/spend`, `/transactions`
      attached to the PR for the visual check between phases.
