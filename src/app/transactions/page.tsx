import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { ensureDefaultBobAccount } from "@/db/seed-account";
import { ensureSeedUser } from "@/db/seed-user";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { backfillCounterparties } from "@/db/counterparty-backfill";
import {
  counterpartyLabel,
  formatDate,
  formatPaise,
  formatPaiseSigned,
} from "@/lib/format";
import { RowActions, type CategoryOption } from "./RowActions";
import type { ExistingSplit } from "./SplitDialog";
import type {
  ExistingAllocation,
  ParticipantOption,
} from "./SettleDialog";
import { AutoDetectButton } from "./AutoDetectButton";

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
}

const isChannel = (s: unknown): s is Channel =>
  typeof s === "string" && (CHANNELS as readonly string[]).includes(s);

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const sp = await searchParams;
  const userId = await ensureSeedUser();
  const account = await ensureDefaultBobAccount();

  await ensureDefaultCategories(userId);
  await backfillCounterparties(account.id, userId);

  const filters = [eq(schema.transactions.accountId, account.id)];
  if (sp.from) filters.push(gte(schema.transactions.txnDate, sp.from));
  if (sp.to) filters.push(lte(schema.transactions.txnDate, sp.to));
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

  // Group lookups for the row renderer.
  const splitByTxn = new Map<string, ExistingSplit>();
  for (const s of splits) {
    splitByTxn.set(s.transactionId, {
      totalPaise: Number(s.totalPaise),
      yourSharePaise: Number(s.yourSharePaise),
      note: s.note,
      participants: participantsAll
        .filter((p) => p.splitId === s.id)
        .map((p) => ({
          id: p.id,
          personName: p.personName,
          expectedAmountPaise: Number(p.expectedAmountPaise),
        })),
    });
  }
  const settlementsByInflow = new Map<string, ExistingAllocation[]>();
  for (const st of settlementsForRows) {
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

  return (
    <main className="mx-auto max-w-6xl p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Transactions</h1>
        <nav className="flex gap-4 text-sm text-neutral-600 dark:text-neutral-400">
          <a href="/" className="underline-offset-4 hover:underline">
            Dashboard
          </a>
          <a href="/timeline" className="underline-offset-4 hover:underline">
            Timeline
          </a>
          <a
            href="/reimbursements"
            className="underline-offset-4 hover:underline"
          >
            Reimbursements
          </a>
          <a href="/import" className="underline-offset-4 hover:underline">
            Import
          </a>
        </nav>
      </header>
      <div className="mt-1 flex items-center justify-between gap-3">
        <p className="text-xs text-neutral-500">
          Account: <strong>{account.name}</strong> ({account.bank})
        </p>
        <AutoDetectButton />
      </div>

      <FiltersBar from={sp.from} to={sp.to} channel={sp.channel} />

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
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
                <th className="py-2 pr-3">Date</th>
                <th className="py-2 pr-3">Channel</th>
                <th className="py-2 pr-3">Counterparty</th>
                <th className="py-2 pr-3 text-right">Amount</th>
                <th className="py-2 pr-3">Tag</th>
                <th className="py-2 pr-3 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-t border-neutral-200 align-top dark:border-neutral-800 ${
                    r.isTransfer ? "opacity-60" : ""
                  }`}
                >
                  <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                    {formatDate(r.txnDate)}
                  </td>
                  <td className="py-2 pr-3">
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
                  <td className="py-2 pr-3">
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
                    />
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs whitespace-nowrap text-neutral-500">
                    {formatPaise(r.balancePaise)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
