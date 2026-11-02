# TanStack DB assessment for Money

Research date: 2026-10-30. This is an architecture assessment from current official documentation and source, not an implementation or a measured performance result.

TanStack DB is a plausible addition to an interactive transaction-review workspace. It offers typed browser collections, reactive relational queries, and optimistic mutations. It would sit between React and the existing authenticated server actions/API; Postgres, Drizzle, authentication, and financial invariants would remain on the server. [Official overview](https://tanstack.com/db/latest/docs/overview)

## Where it fits

- **Transaction review and categorization:** one local collection can feed the visible rows, category labels, review queue, and selection-dependent UI. Editing a row can immediately update every subscribed local view. This is the clearest candidate for a bounded experiment.
- **Split and reimbursement workspaces:** related collections can support joins and draft previews across transactions, participants, and people. Adoption is more involved because a successful financial operation can change multiple server-owned records and aggregates.
- **Read-only dashboards and PDF ingestion:** expected benefit is lower. Browser query reactivity does not accelerate PDF parsing or replace server SQL aggregation. This is an architectural judgment, not a benchmark.

Live queries incrementally maintain joins, filters, and aggregates. They react to changes delivered into collections; detecting another device's or an import job's writes still requires a fetching or sync strategy. [Overview](https://tanstack.com/db/latest/docs/overview), [Query Collection](https://tanstack.com/db/latest/docs/collections/query-collection)

## Smallest integration

Current repository evidence:

- [`RowActions.tsx`](../src/app/transactions/RowActions.tsx) renders category/transfer values from server props and calls actions inside `useTransition`. [`ReviewLaterButton.tsx`](../src/app/transactions/ReviewLaterButton.tsx) follows the same pattern. Shared client collections could update the row, filtered list, and review count together while persistence runs.
- [`transactions/page.tsx`](../src/app/transactions/page.tsx) loads 100 rows per page and separately queries totals over the full server filter. [`review/page.tsx`](../src/app/review/page.tsx) reuses the table-context loader. A client migration must preserve global search, pagination, deep links, and full-filter totals.
- [`actions.ts`](../src/app/transactions/actions.ts) changes both `categoryId` and the derived `isTransfer` flag when setting a category. [`net-event-actions.ts`](../src/app/transactions/net-event-actions.ts) performs allocation validation, a SQL transaction, and invalidates five routes. These operations need canonical reconciliation beyond the visible input field.
- [`package.json`](../package.json) currently includes neither TanStack Query nor DB. The tables/reports are server-rendered; making them reactive requires client consumers and a loading/cache lifecycle. Updating a browser collection will not automatically update a server-rendered report.

For immediate feedback on individual controls alone, React's existing `useOptimistic` offers a smaller experiment. DB becomes more compelling when several views must react to the same related records. That recommendation is an architectural judgment. [React `useOptimistic`](https://react.dev/reference/react/useOptimistic)

Query Collection can load rows through a `queryFn` and persist changes through custom mutation handlers. A handler could call an existing authenticated Next.js server action; this is an integration inference from its customizable function boundary, not a dedicated Next.js Server Actions adapter. The existing server must still authenticate the caller and authorize every supplied ID. TanStack DB does not provide Money's tenant boundary. [Query Collection](https://tanstack.com/db/latest/docs/collections/query-collection)

Start with one account-scoped review slice, categories, and simple note/review/category edits. Return canonical updated records or explicitly read them back. Defer broad migration, sync infrastructure, offline writes, and settlement optimism until the smaller experiment demonstrates value.

On-demand loading passes predicates, ordering, and pagination to the collection loader; an application must translate them to its API. It does not automatically translate arbitrary browser queries into this app's Drizzle SQL. Totals over a loaded page cannot stand in for full-period financial totals. [Query Collection](https://tanstack.com/db/latest/docs/collections/query-collection)

## Mutation correctness

Optimistic state rolls back if a persistence handler throws. Handler completion alone proves only the work the handler actually awaited. A successful HTTP/action response is insufficient to establish that a collection has received canonical server state. [Mutations](https://tanstack.com/db/latest/docs/guides/mutations)

The currently opened Query Collection guide requires handlers to await an explicit `utils.refetch()` or apply confirmed server rows through direct-write utilities before settling. Older search snippets describe automatic refetching and a `{ refetch: false }` return value; those conflict with the live page and should not guide an implementation. [Query Collection](https://tanstack.com/db/latest/docs/collections/query-collection)

Client transactions can coordinate optimistic changes across collections, but backend atomicity, stale-write protection, allocation validation, and idempotency remain application responsibilities. For Money, server-computed transfer flags and related split/settlement changes need reconciliation as well as the field the user edited. [Mutations](https://tanstack.com/db/latest/docs/guides/mutations)

## Next.js, tenants, persistence, and sync

Current SSR documentation includes Next.js App Router streaming through React Server Components. It prescribes a fresh `DbClient` per server request and a stable browser client, with explicit dehydration/hydration. Money would also need browser cache isolation/reset on account changes or sign-out; that last requirement follows from this repository's tenant model. [SSR and Hydration](https://tanstack.com/db/latest/docs/guides/ssr)

Persisting collection rows and retaining pending writes are separate features. Browser SQLite persistence uses an OPFS/runtime wrapper; offline transactions add a durable mutation outbox and require server-side idempotency support. Neither is necessary for an online-only pilot. [SQLite Persistence](https://tanstack.com/db/latest/docs/guides/sqlite-persistence), [Offline Transactions](https://tanstack.com/db/latest/docs/guides/offline-transactions)

Electric Collection can stream Postgres changes and match optimistic writes to confirmed transactions. It is optional. Adding it introduces a sync service and an authorization layer for shapes; Electric's recommended proxy validates credentials and fixes permitted shape parameters server-side. Neon supports logical replication, but this assessment did not inspect the project's database configuration or provision any integration. [Electric Collection](https://tanstack.com/db/latest/docs/collections/electric-collection), [Electric auth](https://electric.ax/docs/sync/guides/auth), [Neon logical replication](https://neon.com/docs/guides/logical-replication-guide)

## Maturity caveat

The official homepage still labels DB beta. The latest repository release page observed reports React DB `0.5.12` with core DB `0.15.2`, and Query Collection `1.4.8`; the documentation also contains a migration guide for a first `1.0.0-rc.1`, phrased partly prospectively. Package versions and documentation are visibly in transition. Pin a mutually compatible, actually published set and validate its exact API before a pilot; do not infer core stability from an adapter's `1.x` version. [Homepage](https://tanstack.com/db/latest), [Official releases](https://github.com/TanStack/db/releases), [RC migration guide](https://tanstack.com/db/latest/docs/guides/migrate-to-1-0-rc)
