import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { AppNav } from "@/components/AppNav";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { backfillCounterparties } from "@/db/counterparty-backfill";
import {
  counterpartyLabel,
  formatDate,
  formatPaise,
  formatPaiseSigned,
} from "@/lib/format";
import { RowActions, type CategoryOption } from "./RowActions";
import {
  SplitSettlementLinks,
  buildExpenseLinks,
  buildReimbursementLinks,
} from "./SplitSettlementLinks";
import { SplitSettlementStatusLine } from "./SplitDialog";
import { buildSplitByTxn } from "@/lib/splits/build-split-by-txn";
import type {
  ExistingAllocation,
  ParticipantOption,
} from "./SettleDialog";
import { AutoDetectButton } from "./AutoDetectButton";
import { getLatestStatementPeriod } from "@/lib/spend/period";

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
}

const isChannel = (s: unknown): s is Channel =>
  typeof s === "string" && (CHANNELS as readonly string[]).includes(s);

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const sp = await searchParams;
  const user = await requireCurrentUser();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const userId = user.id;

  await ensureDefaultCategories(userId);
  await backfillCounterparties(account.id, userId);

  const showAllTime = sp.all === "1";
  let effectiveFrom = sp.from;
  let effectiveTo = sp.to;
  let usingDefaultStatement = false;

  if (!showAllTime && !effectiveFrom && !effectiveTo) {
    const statement = await getLatestStatementPeriod(account.id);
    if (statement?.from && statement?.to) {
      effectiveFrom = statement.from;
      effectiveTo = statement.to;
      usingDefaultStatement = true;
    }
  }

  const periodLabel = showAllTime
    ? "All time"
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

  const rows = await db
    .select({
      id: schema.transactions.id,
      txnDate: schema.transactions.txnDate,
      amountPaise: schema.transactions.amountPaise,
      drCr: schema.transactions.drCr,
      channel: schema.transactions.channel,
      rawDescription: schema.transactions.rawDescription,
      parsedPurpose: schema.transactions.parsedPurpose,
      balancePaise: schema.transactions.balancePaise,
      counterpartyId: schema.transactions.counterpartyId,
      counterpartyDisplayName: schema.counterparties.displayName,
      categoryId: schema.transactions.categoryId,
      isTransfer: schema.transactions.isTransfer,
      needsReview: schema.transactions.needsReview,
      note: schema.transactions.note,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.counterparties,
      eq(schema.transactions.counterpartyId, schema.counterparties.id),
    )
    .where(where)
    .orderBy(
      // Within a date, group rows by their source import (Postgres now() is
      // per-transaction so all rows from one import share createdAt), newest
      // import first. Within an import, the bank's Sr.No is the only correct
      // intraday order. Sr.No is per-statement and would collide across
      // imports without the createdAt grouping.
      desc(schema.transactions.txnDate),
      desc(schema.transactions.createdAt),
      sql`(${schema.transactions.rawPayload}->>'serial')::int desc nulls last`,
    )
    .limit(1000);

  // Load splits, participants, and settlements for the rows in view.
  const txnIds = rows.map((r) => r.id);
  const splits = txnIds.length
    ? await db
        .select()
        .from(schema.splits)
        .where(inArray(schema.splits.transactionId, txnIds))
    : [];
  const splitIds = splits.map((s) => s.id);
  const participantsAll = splitIds.length
    ? await db
        .select()
        .from(schema.splitParticipants)
        .where(inArray(schema.splitParticipants.splitId, splitIds))
    : [];
  const settlementsForRows = txnIds.length
    ? await db
        .select()
        .from(schema.settlements)
        .where(inArray(schema.settlements.inflowTransactionId, txnIds))
    : [];

  const expenseTxn = schema.transactions;
  const expenseCp = schema.counterparties;
  const inflowTxn = schema.transactions;

  const settlementExpenseRows =
    settlementsForRows.length > 0
      ? await db
          .select({
            inflowTransactionId: schema.settlements.inflowTransactionId,
            amountPaise: schema.settlements.amountPaise,
            personName: schema.splitParticipants.personName,
            expenseTransactionId: schema.splits.transactionId,
            expenseTxnDate: expenseTxn.txnDate,
            expenseRawDescription: expenseTxn.rawDescription,
            expenseParsedPurpose: expenseTxn.parsedPurpose,
            expenseCounterpartyDisplayName: expenseCp.displayName,
          })
          .from(schema.settlements)
          .innerJoin(
            schema.splitParticipants,
            eq(
              schema.settlements.splitParticipantId,
              schema.splitParticipants.id,
            ),
          )
          .innerJoin(
            schema.splits,
            eq(schema.splitParticipants.splitId, schema.splits.id),
          )
          .innerJoin(expenseTxn, eq(schema.splits.transactionId, expenseTxn.id))
          .leftJoin(expenseCp, eq(expenseTxn.counterpartyId, expenseCp.id))
          .where(
            inArray(
              schema.settlements.inflowTransactionId,
              settlementsForRows
                .map((s) => s.inflowTransactionId)
                .filter((id): id is string => id != null),
            ),
          )
      : [];

  const participantIds = participantsAll.map((p) => p.id);
  const reimbursementRows =
    participantIds.length > 0
      ? await db
          .select({
            splitTransactionId: schema.splits.transactionId,
            inflowTransactionId: schema.settlements.inflowTransactionId,
            amountPaise: schema.settlements.amountPaise,
            personName: schema.splitParticipants.personName,
            inflowTxnDate: inflowTxn.txnDate,
            inflowRawDescription: inflowTxn.rawDescription,
            inflowCounterpartyDisplayName: schema.counterparties.displayName,
          })
          .from(schema.settlements)
          .innerJoin(
            schema.splitParticipants,
            eq(
              schema.settlements.splitParticipantId,
              schema.splitParticipants.id,
            ),
          )
          .innerJoin(
            schema.splits,
            eq(schema.splitParticipants.splitId, schema.splits.id),
          )
          .innerJoin(
            inflowTxn,
            eq(schema.settlements.inflowTransactionId, inflowTxn.id),
          )
          .leftJoin(
            schema.counterparties,
            eq(inflowTxn.counterpartyId, schema.counterparties.id),
          )
          .where(
            inArray(schema.settlements.splitParticipantId, participantIds),
          )
      : [];

  const expenseLinksByInflow = buildExpenseLinks(settlementExpenseRows);
  const reimbursementsByExpense = buildReimbursementLinks(reimbursementRows);

  const settlementsByInflow = new Map<string, ExistingAllocation[]>();
  for (const st of settlementsForRows) {
    if (!st.inflowTransactionId) continue;
    const arr = settlementsByInflow.get(st.inflowTransactionId) ?? [];
    arr.push({
      splitParticipantId: st.splitParticipantId,
      amountPaise: Number(st.amountPaise),
    });
    settlementsByInflow.set(st.inflowTransactionId, arr);
  }

  // For the SettleDialog: list every participant across all splits in the
  // account, with how much has already been settled across all inflows.
  const allSplitsForAccount = await db
    .select({
      id: schema.splits.id,
      transactionId: schema.splits.transactionId,
      txnDate: schema.transactions.txnDate,
      rawDescription: schema.transactions.rawDescription,
    })
    .from(schema.splits)
    .innerJoin(
      schema.transactions,
      eq(schema.splits.transactionId, schema.transactions.id),
    )
    .where(eq(schema.transactions.accountId, account.id));
  const allParticipants = allSplitsForAccount.length
    ? await db
        .select()
        .from(schema.splitParticipants)
        .where(
          inArray(
            schema.splitParticipants.splitId,
            allSplitsForAccount.map((s) => s.id),
          ),
        )
    : [];
  const allSettlements = allSplitsForAccount.length
    ? await db
        .select({
          splitParticipantId: schema.settlements.splitParticipantId,
          amountPaise: schema.settlements.amountPaise,
        })
        .from(schema.settlements)
        .where(
          inArray(
            schema.settlements.splitParticipantId,
            allParticipants.map((p) => p.id),
          ),
        )
    : [];
  const settledByParticipant = new Map<string, number>();
  for (const s of allSettlements) {
    settledByParticipant.set(
      s.splitParticipantId,
      (settledByParticipant.get(s.splitParticipantId) ?? 0) +
        Number(s.amountPaise),
    );
  }

  const splitByTxn = buildSplitByTxn(
    splits,
    participantsAll,
    settledByParticipant,
  );

  const splitMetaById = new Map(allSplitsForAccount.map((s) => [s.id, s]));
  const participantOptions: ParticipantOption[] = allParticipants.map((p) => {
    const meta = splitMetaById.get(p.splitId)!;
    return {
      id: p.id,
      personName: p.personName,
      expectedAmountPaise: Number(p.expectedAmountPaise),
      splitTransactionDate: formatDate(meta.txnDate),
      splitTransactionDescription:
        counterpartyLabel(meta.rawDescription) ?? meta.rawDescription,
      alreadySettledPaise: settledByParticipant.get(p.id) ?? 0,
    };
  });

  // Net spend SQL: when a debit has a split, count only your_share; when a
  // credit is a settlement, exclude it (already accounted for via your_share).
  const [totals] = await db
    .select({
      debit: sql<number>`coalesce(sum(case when ${schema.transactions.drCr} = 'debit' then ${schema.transactions.amountPaise} else 0 end), 0)::bigint`,
      credit: sql<number>`coalesce(sum(case when ${schema.transactions.drCr} = 'credit' then ${schema.transactions.amountPaise} else 0 end), 0)::bigint`,
      netSelf: sql<number>`
        coalesce(sum(
          case
            when ${schema.transactions.isTransfer} = true then 0
            when ${schema.transactions.drCr} = 'debit'
              then coalesce((select ${schema.splits.yourSharePaise} from ${schema.splits} where ${schema.splits.transactionId} = ${schema.transactions.id}), ${schema.transactions.amountPaise})
            when ${schema.transactions.drCr} = 'credit'
              and exists (select 1 from ${schema.settlements} where ${schema.settlements.inflowTransactionId} = ${schema.transactions.id})
              then 0
            when ${schema.transactions.drCr} = 'credit'
              then -1 * ${schema.transactions.amountPaise}
            else 0
          end
        ), 0)::bigint
      `,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.transactions)
    .where(where);

  const totalDebit = Number(totals.debit);
  const totalCredit = Number(totals.credit);
  const netSpend = Number(totals.netSelf);

  const categories = await db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      kind: schema.categories.kind,
    })
    .from(schema.categories)
    .where(eq(schema.categories.userId, userId))
    .orderBy(asc(schema.categories.kind), asc(schema.categories.name));

  const categoryOptions: CategoryOption[] = categories;

  const personRows = await db
    .select({ name: schema.persons.name })
    .from(schema.persons)
    .where(eq(schema.persons.userId, userId))
    .orderBy(asc(schema.persons.name));
  const knownPersonNames = personRows.map((p) => p.name);

  return (
    <main className="mx-auto max-w-6xl p-8">
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

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">
          No transactions match these filters.
        </p>
      ) : (
        <div className="relative mt-3">
          <p className="mb-2 text-xs text-neutral-500 md:hidden">
            Swipe horizontally for amount, tags, and actions →
          </p>
          <div className="overflow-x-auto rounded border border-neutral-200 dark:border-neutral-800">
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
                  } ${r.needsReview ? "border-l-2 border-l-amber-400/70 pl-1 dark:border-l-amber-500/60" : ""} ${isLinked ? "border-l-2 border-l-violet-400/60 pl-1 dark:border-l-violet-600/50" : ""}`}
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
                      <div className="mt-0.5 text-xs italic text-amber-700 dark:text-amber-400">
                        {r.note}
                      </div>
                    )}
                    <SplitSettlementLinks
                      expenseLinks={expenseLinks}
                      reimbursementLinks={reimbursementLinks}
                    />
                    {existingSplit && (
                      <SplitSettlementStatusLine split={existingSplit} />
                    )}
                  </td>
                  <td
                    className={`py-2 pr-3 text-right font-mono whitespace-nowrap ${
                      r.drCr === "debit"
                        ? "text-red-700 dark:text-red-400"
                        : "text-emerald-700 dark:text-emerald-400"
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
                      categories={categoryOptions}
                      existingSplit={splitByTxn.get(r.id) ?? null}
                      existingSettlement={settlementsByInflow.get(r.id) ?? []}
                      participants={participantOptions}
                      knownPersonNames={knownPersonNames}
                      note={r.note}
                      needsReview={r.needsReview}
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
        </div>
      )}
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
