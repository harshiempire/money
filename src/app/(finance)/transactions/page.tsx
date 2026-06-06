import { and, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { AppNav } from "@/components/AppNav";
import {
  getBobAccount,
  getCurrentUser,
  ensureTenantDefaults,
  runCounterpartyBackfill,
} from "@/lib/auth/request-tenant";
import { formatPaise, formatPaiseSigned } from "@/lib/format";
import { netSpendTotals } from "@/domain/spend/net";
import { AutoDetectButton } from "./AutoDetectButton";
import {
  getLatestStatementPeriod,
  getStatementPeriodForDate,
} from "@/lib/spend/period";
import { ScrollToTransaction } from "./ScrollToTransaction";
import { loadTransactionTableContext } from "./load-table-context";
import { TransactionTable } from "./TransactionTable";

export const dynamic = "force-dynamic";

const CHANNELS = [
  "upi",
  "imps",
  "neft",
  "rtgs",
  "cheque",
  "cash",
  "card",
  "opening",
  "other",
] as const;
type Channel = (typeof CHANNELS)[number];

interface PageSearchParams {
  from?: string;
  to?: string;
  channel?: string;
  all?: string;
  txn?: string;
}

const isChannel = (s: unknown): s is Channel =>
  typeof s === "string" && (CHANNELS as readonly string[]).includes(s);

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const sp = await searchParams;
  const user = await getCurrentUser();
  const account = await getBobAccount();
  const userId = user.id;

  await ensureTenantDefaults();
  await runCounterpartyBackfill();

  const showAllTime = sp.all === "1";
  const highlightTxnId = sp.txn?.trim() || null;
  let effectiveFrom = sp.from;
  let effectiveTo = sp.to;
  let usingDefaultStatement = false;
  let linkedTxnNavigation = false;
  let linkedTxnNotFound = false;

  if (highlightTxnId && !showAllTime) {
    const [target] = await db
      .select({ txnDate: schema.transactions.txnDate })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.id, highlightTxnId),
          eq(schema.transactions.accountId, account.id),
        ),
      )
      .limit(1);

    if (!target) {
      linkedTxnNotFound = true;
    } else {
      const statement = await getStatementPeriodForDate(
        account.id,
        target.txnDate,
      );
      effectiveFrom = statement?.from ?? target.txnDate;
      effectiveTo = statement?.to ?? target.txnDate;
      linkedTxnNavigation = true;
      usingDefaultStatement = Boolean(statement);
    }
  } else if (!showAllTime && !effectiveFrom && !effectiveTo) {
    const statement = await getLatestStatementPeriod(account.id);
    if (statement?.from && statement?.to) {
      effectiveFrom = statement.from;
      effectiveTo = statement.to;
      usingDefaultStatement = true;
    }
  }

  const periodLabel = showAllTime
    ? "All time"
    : linkedTxnNavigation && effectiveFrom && effectiveTo
      ? `${effectiveFrom} → ${effectiveTo} (linked transaction)`
      : usingDefaultStatement && effectiveFrom && effectiveTo
        ? `${effectiveFrom} → ${effectiveTo} (latest statement)`
        : effectiveFrom || effectiveTo
          ? `${effectiveFrom ?? "…"} → ${effectiveTo ?? "…"}`
          : null;

  const filters = [eq(schema.transactions.accountId, account.id)];
  if (effectiveFrom) filters.push(gte(schema.transactions.txnDate, effectiveFrom));
  if (effectiveTo) filters.push(lte(schema.transactions.txnDate, effectiveTo));
  if (isChannel(sp.channel))
    filters.push(eq(schema.transactions.channel, sp.channel));

  const where = and(...filters);

  const [ctx, totals] = await Promise.all([
    loadTransactionTableContext(account.id, userId, where),
    netSpendTotals(
      account.id,
      showAllTime ? null : (effectiveFrom ?? null),
      showAllTime ? null : (effectiveTo ?? null),
      userId,
    ),
  ]);

  const { rows } = ctx;
  const highlightMissingFromList =
    highlightTxnId != null &&
    !linkedTxnNotFound &&
    !rows.some((r) => r.id === highlightTxnId);

  const totalDebit = totals.totalDebitPaise;
  const totalCredit = totals.totalCreditPaise;
  const netSpend = totals.netSelfPaise;

  return (
    <main className="mx-auto max-w-6xl p-8">
      <ScrollToTransaction transactionId={highlightTxnId} />
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Transactions</h1>
        <AppNav current="/transactions" />
      </header>
      <div className="mt-1 flex items-center justify-between gap-3">
        <p className="text-xs text-neutral-500">
          Account: <strong>{account.name}</strong> ({account.bank})
        </p>
        <AutoDetectButton />
      </div>

      <FiltersBar
        from={effectiveFrom}
        to={effectiveTo}
        channel={sp.channel}
      />

      {periodLabel && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-neutral-200 px-3 py-2 text-xs dark:border-neutral-800">
          <span className="text-neutral-500">Period:</span>
          <span className="font-mono text-neutral-800 dark:text-neutral-200">
            {periodLabel}
          </span>
          {showAllTime ? (
            <a
              href="/transactions"
              className="text-neutral-600 underline-offset-2 hover:underline dark:text-neutral-400"
            >
              Latest statement
            </a>
          ) : (
            <a
              href="/transactions?all=1"
              className="text-neutral-600 underline-offset-2 hover:underline dark:text-neutral-400"
            >
              Show all time
            </a>
          )}
        </div>
      )}

      {linkedTxnNotFound && (
        <p className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          That transaction was not found in this account.
        </p>
      )}

      {highlightMissingFromList && (
        <p className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          The linked transaction is outside the current filters.{" "}
          <a
            href={`/transactions?txn=${highlightTxnId}&all=1#txn-${highlightTxnId}`}
            className="underline underline-offset-2"
          >
            Show all time
          </a>{" "}
          to locate it.
        </p>
      )}

      {linkedTxnNavigation && !linkedTxnNotFound && !highlightMissingFromList && (
        <p className="mt-4 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
          Opened the statement period containing the linked transaction.
        </p>
      )}

      <section className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <Stat label="Debits" value={formatPaise(totalDebit)} tone="debit" />
        <Stat label="Credits" value={formatPaise(totalCredit)} tone="credit" />
        <Stat
          label="Gross net"
          value={`${totalCredit - totalDebit >= 0 ? "+" : "−"} ${formatPaise(Math.abs(totalCredit - totalDebit))}`}
        />
        <Stat
          label="Net personal spend"
          value={formatPaise(netSpend)}
          tone="debit"
          hint="excludes transfers, splits use your share, settlements neutralized"
        />
      </section>

      <p className="mt-3 text-xs text-neutral-500">
        Showing {rows.length} of {totals.count} transaction
        {totals.count === 1 ? "" : "s"}.
      </p>

      <TransactionTable
        {...ctx}
        emptyMessage="No transactions match these filters."
      />
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "debit" | "credit";
  hint?: string;
}) {
  const toneClass =
    tone === "debit"
      ? "text-red-700 dark:text-red-400"
      : tone === "credit"
        ? "text-emerald-700 dark:text-emerald-400"
        : "";
  return (
    <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs uppercase text-neutral-500">{label}</div>
      <div className={`mt-1 font-mono text-base ${toneClass}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-neutral-500">{hint}</div>}
    </div>
  );
}

function FiltersBar({
  from,
  to,
  channel,
}: {
  from?: string;
  to?: string;
  channel?: string;
}) {
  return (
    <form
      method="get"
      className="mt-5 flex flex-wrap items-end gap-3 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"
    >
      <label className="flex flex-col">
        <span className="text-xs uppercase text-neutral-500">From</span>
        <input
          type="date"
          name="from"
          defaultValue={from ?? ""}
          className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
        />
      </label>
      <label className="flex flex-col">
        <span className="text-xs uppercase text-neutral-500">To</span>
        <input
          type="date"
          name="to"
          defaultValue={to ?? ""}
          className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
        />
      </label>
      <label className="flex flex-col">
        <span className="text-xs uppercase text-neutral-500">Channel</span>
        <select
          name="channel"
          defaultValue={channel ?? ""}
          className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
        >
          <option value="">All</option>
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          Apply
        </button>
        <a
          href="/transactions"
          className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
        >
          Reset
        </a>
      </div>
    </form>
  );
}
