import { and, eq, gte, lte, isNull, or, sql, desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { AppShell } from "@/components/AppShell";
import {
  ensureTenantDefaults,
  getBobAccount,
  getCurrentUser,
} from "@/lib/auth/request-tenant";
import {
  counterpartyLabel,
  formatDate,
  formatPaise,
  formatPaiseSigned,
} from "@/lib/format";
import { RowActions } from "./RowActions";
import { SplitSettlementLinks } from "./SplitSettlementLinks";
import { SplitSettlementStatusLine } from "./SplitDialog";
import { AutoDetectButton } from "./AutoDetectButton";
import {
  getLatestStatementPeriod,
  getStatementPeriodForDate,
} from "@/lib/spend/period";
import { ScrollToTransaction } from "./ScrollToTransaction";
import {
  loadPeriodTxnTotals,
  loadTransactionTableContext,
} from "./load-table-context";

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
  q?: string;
  page?: string;
  import?: string;
  attention?: string;
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

  // Categories only — counterparty backfill is not required for list chrome
  // and used to add a full-account scan on every navigation.
  await ensureTenantDefaults();

  const query = (sp.q ?? "").trim().slice(0, 200);
  const pageSize = 100;
  let currentPage = Math.max(1, Math.min(1000000, Number.parseInt(sp.page ?? "1", 10) || 1));
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

  if (sp.import) filters.push(eq(schema.transactions.sourceImportId, sp.import));
  if (sp.attention === "1") {
    filters.push(or(isNull(schema.transactions.categoryId), eq(schema.transactions.needsReview, true))!);
  }
  if (query) {
    // Literal substring matching: %, _ and backslashes are not search wildcards.
    const textMatch = sql<boolean>`(
      strpos(lower(${schema.transactions.rawDescription}), lower(${query})) > 0
      or strpos(lower(coalesce(${schema.transactions.note}, '')), lower(${query})) > 0
      or strpos(lower(coalesce(${schema.transactions.parsedPurpose}, '')), lower(${query})) > 0
      or exists (select 1 from ${schema.counterparties}
        where ${schema.counterparties.id} = ${schema.transactions.counterpartyId}
        and ${schema.counterparties.userId} = ${userId}
        and strpos(lower(${schema.counterparties.displayName}), lower(${query})) > 0)
    )`;
    const amountText = query.replace(/^(?:₹|rs\.?|inr)\s*/i, "").replace(/,/g, "").trim();
    const amount = /^\d+(?:\.\d{1,2})?$/.test(amountText)
      ? Math.round(Number(amountText) * 100) : NaN;
    filters.push(Number.isSafeInteger(amount)
      ? or(textMatch, eq(schema.transactions.amountPaise, amount))!
      : textMatch);
  }
  const where = and(...filters);
  // Deep links must locate their transaction even beyond the first page.
  if (highlightTxnId && !sp.page) {
    const ordered = await db.select({ id: schema.transactions.id })
      .from(schema.transactions).where(where)
      .orderBy(desc(schema.transactions.txnDate), desc(schema.transactions.createdAt),
        sql`(${schema.transactions.rawPayload}->>'serial')::int desc nulls last`, desc(schema.transactions.id));
    const index = ordered.findIndex((row) => row.id === highlightTxnId);
    if (index >= 0) currentPage = Math.floor(index / pageSize) + 1;
  }
  const offset = (currentPage - 1) * pageSize;
  const periodHref = (allTime: boolean) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (isChannel(sp.channel)) params.set("channel", sp.channel);
    if (sp.import) params.set("import", sp.import);
    if (sp.attention === "1") params.set("attention", "1");
    if (allTime) params.set("all", "1");
    return `/transactions${params.size ? `?${params.toString()}` : ""}`;
  };
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...sp, from: effectiveFrom, to: effectiveTo })) {
      if (value) params.set(key, value);
    }
    params.set("page", String(page));
    return `/transactions?${params.toString()}`;
  };

  const [ctx, totals] = await Promise.all([
    loadTransactionTableContext(account.id, userId, where, { limit: pageSize, offset }),
    loadPeriodTxnTotals(where),
  ]);

  const {
    rows,
    splitByTxn,
    settlementsByInflow,
    expenseLinksByInflow,
    reimbursementsByExpense,
    participantOptions,
    categoryOptions,
    knownPersonNames,
    counterpartyPersonHints,
    openReceivables,
    openPayables,
    netEventsByTxn,
    creditResidualByTxn,
  } = ctx;

  const visibleTxnIds = rows.map((r) => r.id);
  const totalDebit = totals.debit;
  const totalCredit = totals.credit;
  const netSpend = totals.netSelf;

  const highlightMissingFromList =
    highlightTxnId != null &&
    !linkedTxnNotFound &&
    !rows.some((r) => r.id === highlightTxnId);

  return (
    <AppShell
      title="Transactions"
      width="wide"
      actions={<AutoDetectButton />}
    >
      <ScrollToTransaction transactionId={highlightTxnId} />
      <p className="mt-1 text-xs text-neutral-500">
        Account: <strong>{account.name}</strong> ({account.bank})
      </p>

      <FiltersBar
        from={effectiveFrom}
        to={effectiveTo}
        channel={sp.channel}
        query={query}
        showAllTime={showAllTime}
        importId={sp.import}
        attention={sp.attention}
      />

      {(sp.import || sp.attention === "1") && (
        <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
          {sp.import ? "Transactions newly added by this import" : "Transactions"}
          {sp.attention === "1" ? " · uncategorized or flagged for review" : ""}
        </p>
      )}

      {periodLabel && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-neutral-200 px-3 py-2 text-xs dark:border-neutral-800">
          <span className="text-neutral-500">Period:</span>
          <span className="font-mono text-neutral-800 dark:text-neutral-200">
            {periodLabel}
          </span>
          {showAllTime ? (
            <a
              href={periodHref(false)}
              className="text-neutral-600 underline-offset-2 hover:underline dark:text-neutral-400"
            >
              Latest statement
            </a>
          ) : (
            <a
              href={periodHref(true)}
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
        Showing {rows.length ? offset + 1 : 0}–{rows.length ? offset + rows.length : 0} of {totals.count} transaction
        {totals.count === 1 ? "" : "s"}.
      </p>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">
          No transactions match these filters.
        </p>
      ) : (
        <div className="relative mt-3">
          <div className="hidden overflow-x-auto rounded border border-neutral-200 md:block dark:border-neutral-800">
          <table className="min-w-[720px] w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
                <th className="py-2 pr-3">Date</th>
                <th className="hidden py-2 pr-3 sm:table-cell">Channel</th>
                <th className="py-2 pr-3">Counterparty</th>
                <th className="py-2 pr-3 text-right">Amount</th>
                <th className="py-2 pr-3">Tag</th>
                <th className="hidden py-2 pr-3 text-right lg:table-cell">
                  Balance
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const expenseLinks = expenseLinksByInflow.get(r.id);
                const reimbursementLinks = reimbursementsByExpense.get(r.id);
                const existingSplit = splitByTxn.get(r.id);
                const isLinked =
                  (expenseLinks?.length ?? 0) > 0 ||
                  (reimbursementLinks?.length ?? 0) > 0;
                return (
                <tr
                  key={r.id}
                  id={`txn-${r.id}`}
                  className={`scroll-mt-4 border-t border-neutral-200 align-top dark:border-neutral-800 ${
                    r.isTransfer ? "opacity-60" : ""
                  } ${highlightTxnId === r.id ? "bg-sky-50/80 dark:bg-sky-950/30" : ""} ${r.needsReview ? "border-l-2 border-l-amber-400/70 pl-1 dark:border-l-amber-500/60" : ""} ${isLinked ? "border-l-2 border-l-violet-400/60 pl-1 dark:border-l-violet-600/50" : ""}`}
                >
                  <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                    {formatDate(r.txnDate)}
                  </td>
                  <td className="hidden py-2 pr-3 sm:table-cell">
                    <ChannelPill channel={r.channel} />
                  </td>
                  <td className="py-2 pr-3">
                    <div className="font-medium">
                      {r.counterpartyDisplayName ??
                        counterpartyLabel(r.rawDescription)}
                    </div>
                    {r.parsedPurpose && (
                      <div className="text-xs text-neutral-500">
                        {r.parsedPurpose}
                      </div>
                    )}
                    {r.note && (
                      <div className="mt-0.5 text-xs italic text-owed-to-me">
                        {r.note}
                      </div>
                    )}
                    <SplitSettlementLinks
                      residual={creditResidualByTxn.get(r.id)}
                      expenseLinks={expenseLinks}
                      reimbursementLinks={reimbursementLinks}
                      visibleTxnIds={visibleTxnIds}
                    />
                    {existingSplit && (
                      <SplitSettlementStatusLine split={existingSplit} />
                    )}
                  </td>
                  <td
                    className={`py-2 pr-3 text-right font-mono whitespace-nowrap ${
                      r.drCr === "debit"
                        ? "text-spend"
                        : "text-inflow"
                    }`}
                  >
                    {formatPaiseSigned(r.amountPaise, r.drCr)}
                  </td>
                  <td className="min-w-[11rem] py-2 pr-3">
                    <RowActions
                      transactionId={r.id}
                      drCr={r.drCr}
                      amountPaise={r.amountPaise}
                      categoryId={r.categoryId}
                      isTransfer={r.isTransfer}
                      counterpartyId={r.counterpartyId}
                      counterpartyDisplayName={r.counterpartyDisplayName}
                      rawDescription={r.rawDescription}
                      counterpartyPersonHints={counterpartyPersonHints}
                      categories={categoryOptions}
                      existingSplit={splitByTxn.get(r.id) ?? null}
                      existingSettlement={settlementsByInflow.get(r.id) ?? []}
                      residual={
                        creditResidualByTxn.get(r.id) ?? {
                          acknowledgedPaise: 0,
                          disposition: null,
                          overpaymentPayablePaise: 0,
                          netSettledPaise: 0,
                        }
                      }
                      participants={participantOptions}
                      knownPersonNames={knownPersonNames}
                      note={r.note}
                      needsReview={r.needsReview}
                      receivables={openReceivables}
                      payables={openPayables}
                      netEventId={netEventsByTxn.get(r.id)?.netEventId}
                      netEventLegs={netEventsByTxn.get(r.id)?.legs.map((l) => ({
                        kind: l.kind,
                        targetId: l.targetId,
                        amountPaise: l.amountPaise,
                        method:
                          l.method === "bank"
                            ? ("bank" as const)
                            : ("offset" as const),
                      }))}
                      txnDate={r.txnDate}
                    />
                  </td>
                  <td className="hidden py-2 pr-3 text-right font-mono text-xs whitespace-nowrap text-neutral-500 lg:table-cell">
                    {formatPaise(r.balancePaise)}
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
          </div>

          <ul className="space-y-2 md:hidden">
            {rows.map((r) => {
              const expenseLinks = expenseLinksByInflow.get(r.id);
              const reimbursementLinks = reimbursementsByExpense.get(r.id);
              const existingSplit = splitByTxn.get(r.id);
              const isLinked =
                (expenseLinks?.length ?? 0) > 0 ||
                (reimbursementLinks?.length ?? 0) > 0;
              return (
                <li
                  key={r.id}
                  id={`txn-${r.id}`}
                  className={`scroll-mt-4 rounded border border-neutral-200 p-3 dark:border-neutral-800 ${
                    r.isTransfer ? "opacity-60" : ""
                  } ${highlightTxnId === r.id ? "bg-sky-50/80 dark:bg-sky-950/30" : ""} ${r.needsReview ? "border-l-2 border-l-amber-400/70 dark:border-l-amber-500/60" : ""} ${isLinked ? "border-l-2 border-l-violet-400/60 dark:border-l-violet-600/50" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-neutral-500">
                        {formatDate(r.txnDate)}
                      </span>
                      <ChannelPill channel={r.channel} />
                    </div>
                    <span
                      className={`font-mono text-xs whitespace-nowrap ${
                        r.drCr === "debit" ? "text-spend" : "text-inflow"
                      }`}
                    >
                      {formatPaiseSigned(r.amountPaise, r.drCr)}
                    </span>
                  </div>
                  <div className="mt-2 text-sm">
                    <div className="font-medium">
                      {r.counterpartyDisplayName ??
                        counterpartyLabel(r.rawDescription)}
                    </div>
                    {r.parsedPurpose && (
                      <div className="text-xs text-neutral-500">
                        {r.parsedPurpose}
                      </div>
                    )}
                    {r.note && (
                      <div className="mt-0.5 text-xs italic text-owed-to-me">
                        {r.note}
                      </div>
                    )}
                    <SplitSettlementLinks
                      residual={creditResidualByTxn.get(r.id)}
                      expenseLinks={expenseLinks}
                      reimbursementLinks={reimbursementLinks}
                      visibleTxnIds={visibleTxnIds}
                    />
                    {existingSplit && (
                      <SplitSettlementStatusLine split={existingSplit} />
                    )}
                  </div>
                  <div className="mt-2 flex items-start justify-between gap-2">
                    <RowActions
                      transactionId={r.id}
                      drCr={r.drCr}
                      amountPaise={r.amountPaise}
                      categoryId={r.categoryId}
                      isTransfer={r.isTransfer}
                      counterpartyId={r.counterpartyId}
                      counterpartyDisplayName={r.counterpartyDisplayName}
                      rawDescription={r.rawDescription}
                      counterpartyPersonHints={counterpartyPersonHints}
                      categories={categoryOptions}
                      existingSplit={splitByTxn.get(r.id) ?? null}
                      existingSettlement={settlementsByInflow.get(r.id) ?? []}
                      residual={
                        creditResidualByTxn.get(r.id) ?? {
                          acknowledgedPaise: 0,
                          disposition: null,
                          overpaymentPayablePaise: 0,
                          netSettledPaise: 0,
                        }
                      }
                      participants={participantOptions}
                      knownPersonNames={knownPersonNames}
                      note={r.note}
                      needsReview={r.needsReview}
                      receivables={openReceivables}
                      payables={openPayables}
                      netEventId={netEventsByTxn.get(r.id)?.netEventId}
                      netEventLegs={netEventsByTxn.get(r.id)?.legs.map((l) => ({
                        kind: l.kind,
                        targetId: l.targetId,
                        amountPaise: l.amountPaise,
                        method:
                          l.method === "bank"
                            ? ("bank" as const)
                            : ("offset" as const),
                      }))}
                      txnDate={r.txnDate}
                    />
                    <span className="font-mono text-xs whitespace-nowrap text-neutral-500">
                      {formatPaise(r.balancePaise)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {(currentPage > 1 || offset + rows.length < totals.count) && (
        <nav aria-label="Transaction pages" className="mt-5 flex items-center justify-between gap-3 text-sm">
          {currentPage > 1 ? <a className="rounded border border-neutral-300 px-3 py-2 dark:border-neutral-700" href={pageHref(currentPage - 1)}>← Previous</a> : <span />}
          <span className="text-neutral-500">Page {currentPage} of {Math.max(1, Math.ceil(totals.count / pageSize))}</span>
          {offset + rows.length < totals.count && <a className="rounded border border-neutral-300 px-3 py-2 dark:border-neutral-700" href={pageHref(currentPage + 1)}>Load more →</a>}
        </nav>
      )}
    </AppShell>
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
      ? "text-spend"
      : tone === "credit"
        ? "text-inflow"
        : "";
  return (
    <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs uppercase text-neutral-500">{label}</div>
      <div className={`mt-1 font-mono text-base ${toneClass}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-neutral-500">{hint}</div>}
    </div>
  );
}

function ChannelPill({ channel }: { channel: string }) {
  const palette: Record<string, string> = {
    upi: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200",
    imps: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
    neft: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
    rtgs: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
    opening:
      "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  };
  const cls =
    palette[channel] ??
    "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {channel}
    </span>
  );
}

function FiltersBar({
  from,
  to,
  channel,
  query,
  showAllTime,
  importId,
  attention,
}: {
  from?: string;
  to?: string;
  channel?: string;
  query: string;
  showAllTime: boolean;
  importId?: string;
  attention?: string;
}) {
  return (
    <form
      method="get"
      className="mt-5 flex flex-wrap items-end gap-3 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"
    >
      {showAllTime && <input type="hidden" name="all" value="1" />}
      {importId && <input type="hidden" name="import" value={importId} />}
      {attention && <input type="hidden" name="attention" value={attention} />}
      <label className="flex min-w-48 flex-1 flex-col">
        <span className="text-xs uppercase text-neutral-500">Search</span>
        <input type="search" name="q" defaultValue={query} maxLength={200}
          placeholder="Name, UPI ID, note or amount"
          className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700" />
      </label>
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
