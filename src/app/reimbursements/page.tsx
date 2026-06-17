import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { getAllAccountsForUser } from "@/db/money-account";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { AppShell } from "@/components/AppShell";
import { SpendPeriodPicker } from "@/components/spend/SpendPeriodPicker";
import { counterpartyLabel, formatDate, formatPaise } from "@/lib/format";
import { transactionHref } from "@/lib/transactions/href";
import {
  listStatementPeriods,
  resolveSpendPeriod,
  spendPeriodHref,
  type SpendSearchParams,
} from "@/lib/spend/period";
import {
  summarizeSplitSettlement,
  type SplitSettlementStatus,
} from "@/lib/splits/settlement-status";
import {
  CashSettlementButton,
  type CashSettlement,
} from "./CashSettlementDialog";
import { SplitAwaitingItem } from "./SplitAwaitingItem";
import { PureOffsetNetSettleButton } from "./PureOffsetNetSettleButton";
import {
  loadOpenPayablesForUser,
  loadOpenReceivablesForAccount,
} from "@/lib/net-events/load-net-settle-data";

export const dynamic = "force-dynamic";

interface ParticipantRow {
  participantId: string;
  splitId: string;
  personId: string | null;
  personName: string;
  expectedPaise: number;
  settledPaise: number;
  bankSettledPaise: number;
  cashSettledPaise: number;
  outstandingPaise: number;
  cashSettlements: CashSettlement[];
  ageDays: number;
  txnDate: string;
  txnDescription: string;
  txnId: string;
}

interface SplitSummaryRow {
  splitId: string;
  txnDate: string;
  txnDescription: string;
  txnId: string;
  txnNote: string | null;
  status: SplitSettlementStatus;
  expectedReimbursePaise: number;
  settledReimbursePaise: number;
  outstandingReimbursePaise: number;
  settledParticipantCount: number;
  totalParticipantCount: number;
}

const today = new Date();
const ageBucket = (days: number): string => {
  if (days <= 7) return "0–7 days";
  if (days <= 30) return "8–30 days";
  if (days <= 60) return "31–60 days";
  return "60+ days";
};

export default async function ReimbursementsPage({
  searchParams,
}: {
  searchParams: Promise<SpendSearchParams>;
}) {
  const sp = await searchParams;
  const user = await requireCurrentUser();
  const accounts = await getAllAccountsForUser(user.id);
  const accountIds = accounts.map((a) => a.id);

  const [resolved, statements] = await Promise.all([
    resolveSpendPeriod(accountIds, sp),
    listStatementPeriods(accountIds),
  ]);
  const { period } = resolved;

  const [openReceivables, openPayables, categories, personRows] =
    await Promise.all([
    loadOpenReceivablesForAccount(accountIds),
    loadOpenPayablesForUser(user.id),
    db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        kind: schema.categories.kind,
      })
      .from(schema.categories)
      .where(eq(schema.categories.userId, user.id))
      .orderBy(asc(schema.categories.kind), asc(schema.categories.name)),
    db
      .select({ name: schema.persons.name })
      .from(schema.persons)
      .where(eq(schema.persons.userId, user.id))
      .orderBy(asc(schema.persons.name)),
  ]);

  const categoryOptions = categories;
  const knownPersonNames = personRows.map((p) => p.name);

  const txnFilters = accountIds.length > 0
    ? [inArray(schema.transactions.accountId, accountIds)]
    : [eq(schema.transactions.id, "")];
  if (period.from) txnFilters.push(gte(schema.transactions.txnDate, period.from));
  if (period.to) txnFilters.push(lte(schema.transactions.txnDate, period.to));
  const txnWhere = and(...txnFilters);

  // Splits attached to transactions in this account and period.
  const splitsRaw = await db
    .select({
      splitId: schema.splits.id,
      transactionId: schema.splits.transactionId,
      txnDate: schema.transactions.txnDate,
      rawDescription: schema.transactions.rawDescription,
      txnNote: schema.transactions.note,
    })
    .from(schema.splits)
    .innerJoin(
      schema.transactions,
      eq(schema.splits.transactionId, schema.transactions.id),
    )
    .where(txnWhere);

  const splitIds = splitsRaw.map((s) => s.splitId);
  const participants = splitIds.length
    ? await db
        .select()
        .from(schema.splitParticipants)
        .where(inArray(schema.splitParticipants.splitId, splitIds))
    : [];

  const settlementsByParticipant = new Map<string, number>();
  const bankSettledByParticipant = new Map<string, number>();
  const cashSettledByParticipant = new Map<string, number>();
  const cashSettlementsByParticipant = new Map<string, CashSettlement[]>();
  if (participants.length > 0) {
    const sets = await db
      .select({
        id: schema.settlements.id,
        splitParticipantId: schema.settlements.splitParticipantId,
        amountPaise: schema.settlements.amountPaise,
        method: schema.settlements.method,
        note: schema.settlements.note,
      })
      .from(schema.settlements)
      .where(
        inArray(
          schema.settlements.splitParticipantId,
          participants.map((p) => p.id),
        ),
      );
    for (const s of sets) {
      if (!s.splitParticipantId) continue;
      settlementsByParticipant.set(
        s.splitParticipantId,
        (settlementsByParticipant.get(s.splitParticipantId) ?? 0) +
          Number(s.amountPaise),
      );
      if (s.method === "cash") {
        cashSettledByParticipant.set(
          s.splitParticipantId,
          (cashSettledByParticipant.get(s.splitParticipantId) ?? 0) +
            Number(s.amountPaise),
        );
        const cash =
          cashSettlementsByParticipant.get(s.splitParticipantId) ?? [];
        cash.push({
          id: s.id,
          amountPaise: Number(s.amountPaise),
          note: s.note,
        });
        cashSettlementsByParticipant.set(s.splitParticipantId, cash);
      } else {
        bankSettledByParticipant.set(
          s.splitParticipantId,
          (bankSettledByParticipant.get(s.splitParticipantId) ?? 0) +
            Number(s.amountPaise),
        );
      }
    }
  }

  const splitMeta = new Map(splitsRaw.map((s) => [s.splitId, s]));

  const rows: ParticipantRow[] = participants.map((p) => {
    const meta = splitMeta.get(p.splitId)!;
    const expected = Number(p.expectedAmountPaise);
    const settled = settlementsByParticipant.get(p.id) ?? 0;
    const dt = new Date(meta.txnDate);
    const ageDays = Math.max(
      0,
      Math.floor((today.getTime() - dt.getTime()) / (1000 * 60 * 60 * 24)),
    );
    return {
      participantId: p.id,
      splitId: p.splitId,
      personId: p.personId,
      personName: p.personName,
      expectedPaise: expected,
      settledPaise: settled,
      bankSettledPaise: bankSettledByParticipant.get(p.id) ?? 0,
      cashSettledPaise: cashSettledByParticipant.get(p.id) ?? 0,
      outstandingPaise: Math.max(0, expected - settled),
      cashSettlements: cashSettlementsByParticipant.get(p.id) ?? [],
      ageDays,
      txnDate: meta.txnDate,
      txnDescription: counterpartyLabel(meta.rawDescription),
      txnId: meta.transactionId,
    };
  });

  const outstanding = rows.filter((r) => r.outstandingPaise > 0);
  const settled = rows.filter((r) => r.outstandingPaise === 0);

  // Ageing summary across outstanding rows.
  const buckets = new Map<string, { count: number; total: number }>();
  for (const r of outstanding) {
    const k = ageBucket(r.ageDays);
    const entry = buckets.get(k) ?? { count: 0, total: 0 };
    entry.count += 1;
    entry.total += r.outstandingPaise;
    buckets.set(k, entry);
  }
  const totalOutstanding = outstanding.reduce(
    (s, r) => s + r.outstandingPaise,
    0,
  );

  const personSummary = new Map<
    string,
    { displayName: string; outstandingPaise: number; openCount: number }
  >();
  for (const r of outstanding) {
    const key = r.personId ? `person:${r.personId}` : `name:${r.personName}`;
    const entry = personSummary.get(key) ?? {
      displayName: r.personName,
      outstandingPaise: 0,
      openCount: 0,
    };
    entry.outstandingPaise += r.outstandingPaise;
    entry.openCount += 1;
    personSummary.set(key, entry);
  }
  const byPerson = [...personSummary.entries()]
    .map(([groupKey, row]) => ({ groupKey, ...row }))
    .sort((a, b) => b.outstandingPaise - a.outstandingPaise);

  const participantsBySplit = new Map<string, ParticipantRow[]>();
  for (const r of rows) {
    const group = participantsBySplit.get(r.splitId) ?? [];
    group.push(r);
    participantsBySplit.set(r.splitId, group);
  }

  const splitSummaries: SplitSummaryRow[] = [...participantsBySplit.entries()]
    .map(([splitId, parts]) => {
      const meta = splitMeta.get(splitId)!;
      const summary = summarizeSplitSettlement(
        parts.map((p) => ({
          expectedAmountPaise: p.expectedPaise,
          settledAmountPaise: p.settledPaise,
        })),
      );
      return {
        splitId,
        txnDate: meta.txnDate,
        txnDescription: counterpartyLabel(meta.rawDescription),
        txnId: meta.transactionId,
        txnNote: meta.txnNote,
        ...summary,
      };
    })
    .filter((s) => s.status !== "none")
    .sort((a, b) => a.txnDate.localeCompare(b.txnDate));

  const openSplits = splitSummaries.filter(
    (s) => s.status === "open" || s.status === "partial",
  );
  const settledSplits = splitSummaries.filter((s) => s.status === "settled");

  return (
    <AppShell title="Reimbursements">
      <p className="mt-1 text-xs text-neutral-500">
        Reimbursements for splits in the selected period. Settle inflows from{" "}
        <a className="underline" href="/transactions">
          Transactions
        </a>
        , record cash directly here, or use net settle for GPay-style offsets.{" "}
        <a className="underline" href="/people">
          People
        </a>{" "}
        shows all-time balances.{" "}
        <a className="underline" href={spendPeriodHref(sp)}>
          Spend report
        </a>
      </p>

      <div className="mt-3">
        <PureOffsetNetSettleButton
          receivables={openReceivables}
          payables={openPayables}
          categories={categoryOptions}
          knownPersonNames={knownPersonNames}
        />
      </div>

      <SpendPeriodPicker
        resolved={resolved}
        sp={sp}
        basePath="/reimbursements"
        statementPeriods={statements}
      />

      <section className="mt-6">
        <div className="text-xs uppercase tracking-wide text-neutral-500">
          Outstanding · {period.label}
        </div>
        <div className="mt-1 font-mono text-3xl">
          {formatPaise(totalOutstanding)}
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          {outstanding.length} participant
          {outstanding.length === 1 ? "" : "s"} across {splitsRaw.length} split
          {splitsRaw.length === 1 ? "" : "s"}.
        </p>
      </section>

      {openSplits.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold">Splits awaiting reimbursement</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Expand a split to see who still owes you and record cash paybacks.
          </p>
          <ul className="mt-3 space-y-2">
            {openSplits.map((s) => (
              <li key={s.splitId}>
                <SplitAwaitingItem
                  splitId={s.splitId}
                  txnId={s.txnId}
                  txnDate={s.txnDate}
                  txnDescription={s.txnDescription}
                  txnNote={s.txnNote}
                  status={s.status}
                  expectedReimbursePaise={s.expectedReimbursePaise}
                  settledReimbursePaise={s.settledReimbursePaise}
                  outstandingReimbursePaise={s.outstandingReimbursePaise}
                  settledParticipantCount={s.settledParticipantCount}
                  totalParticipantCount={s.totalParticipantCount}
                  participants={(participantsBySplit.get(s.splitId) ?? []).map(
                    (p) => ({
                      participantId: p.participantId,
                      personName: p.personName,
                      expectedPaise: p.expectedPaise,
                      settledPaise: p.settledPaise,
                      bankSettledPaise: p.bankSettledPaise,
                      cashSettledPaise: p.cashSettledPaise,
                      outstandingPaise: p.outstandingPaise,
                      cashSettlements: p.cashSettlements,
                    }),
                  )}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {settledSplits.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-neutral-500">
            Fully settled splits ({settledSplits.length})
          </h2>
          <ul className="mt-2 space-y-1 text-xs text-neutral-500">
            {settledSplits.map((s) => (
              <li key={s.splitId} className="flex flex-wrap items-center gap-2">
                <span className="text-inflow">
                  ✓
                </span>
                <span>
                  {formatDate(s.txnDate)} · {s.txnDescription} ·{" "}
                  {formatPaise(s.expectedReimbursePaise)} ·{" "}
                  {s.totalParticipantCount} participant
                  {s.totalParticipantCount === 1 ? "" : "s"}
                </span>
                <a
                  href={transactionHref(s.txnId)}
                  className="underline-offset-2 hover:underline"
                >
                  View
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {byPerson.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold">By person</h2>
          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
                <th className="py-2 pr-3">Person</th>
                <th className="py-2 pr-3 text-right">Outstanding</th>
                <th className="py-2 pr-3 text-right">Open splits</th>
              </tr>
            </thead>
            <tbody>
              {byPerson.map((p) => (
                <tr
                  key={p.groupKey}
                  className="border-t border-neutral-200 dark:border-neutral-800"
                >
                  <td className="py-2 pr-3 font-medium">
                    {p.groupKey.startsWith("person:") ? (
                      <a
                        href={`/people/${encodeURIComponent(p.groupKey.replace("person:", ""))}`}
                        className="hover:underline"
                      >
                        {p.displayName}
                      </a>
                    ) : (
                      p.displayName
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-sm text-owed-to-me">
                    {formatPaise(p.outstandingPaise)}
                  </td>
                  <td className="py-2 pr-3 text-right text-xs text-neutral-500">
                    {p.openCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {buckets.size > 0 && (
        <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          {["0–7 days", "8–30 days", "31–60 days", "60+ days"].map((label) => {
            const b = buckets.get(label);
            return (
              <div
                key={label}
                className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
              >
                <div className="text-xs uppercase text-neutral-500">{label}</div>
                <div className="mt-1 font-mono text-base">
                  {b ? formatPaise(b.total) : "—"}
                </div>
                <div className="text-[10px] text-neutral-500">
                  {b ? `${b.count} pending` : "none"}
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Outstanding</h2>
        {outstanding.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            Nothing pending. {rows.length === 0 && "No splits recorded yet."}
          </p>
        ) : (
          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
                <th className="py-2 pr-3">Person</th>
                <th className="py-2 pr-3">Split</th>
                <th className="py-2 pr-3 text-right">Expected</th>
                <th className="py-2 pr-3 text-right">Settled</th>
                <th className="py-2 pr-3 text-right">Outstanding</th>
                <th className="py-2 pr-3 text-right">Age</th>
                <th className="py-2 pr-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {outstanding
                .slice()
                .sort((a, b) => b.ageDays - a.ageDays)
                .map((r) => (
                  <tr
                    key={r.participantId}
                    className="border-t border-neutral-200 dark:border-neutral-800"
                  >
                    <td className="py-2 pr-3 font-medium">{r.personName}</td>
                    <td className="py-2 pr-3 text-xs text-neutral-500">
                      {formatDate(r.txnDate)} · {r.txnDescription}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs">
                      {formatPaise(r.expectedPaise)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs text-neutral-500">
                      <div>{formatPaise(r.settledPaise)}</div>
                      {(r.bankSettledPaise > 0 || r.cashSettledPaise > 0) && (
                        <div className="mt-0.5 font-sans text-[10px] text-neutral-500">
                          {r.bankSettledPaise > 0 &&
                            `${formatPaise(r.bankSettledPaise)} bank`}
                          {r.bankSettledPaise > 0 &&
                            r.cashSettledPaise > 0 &&
                            " · "}
                          {r.cashSettledPaise > 0 &&
                            `${formatPaise(r.cashSettledPaise)} cash`}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-sm text-owed-to-me">
                      {formatPaise(r.outstandingPaise)}
                    </td>
                    <td className="py-2 pr-3 text-right text-xs text-neutral-500">
                      {r.ageDays}d
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <CashSettlementButton
                        splitParticipantId={r.participantId}
                        personName={r.personName}
                        outstandingPaise={r.outstandingPaise}
                        cashSettlements={r.cashSettlements}
                      />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>

      {settled.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold text-neutral-500">
            Settled ({settled.length})
          </h2>
          <ul className="mt-2 space-y-1 text-xs text-neutral-500">
            {settled.map((r) => (
              <li
                key={r.participantId}
                className="flex flex-wrap items-center gap-2"
              >
                <span>
                  {r.personName} · {formatPaise(r.expectedPaise)} ·{" "}
                  {formatDate(r.txnDate)} · {r.txnDescription}
                  {(r.bankSettledPaise > 0 || r.cashSettledPaise > 0) && (
                    <>
                      {" "}
                      · {r.bankSettledPaise > 0 &&
                        `${formatPaise(r.bankSettledPaise)} bank`}
                      {r.bankSettledPaise > 0 &&
                        r.cashSettledPaise > 0 &&
                        " · "}
                      {r.cashSettledPaise > 0 &&
                        `${formatPaise(r.cashSettledPaise)} cash`}
                    </>
                  )}
                </span>
                {r.cashSettlements.length > 0 && (
                  <CashSettlementButton
                    splitParticipantId={r.participantId}
                    personName={r.personName}
                    outstandingPaise={r.outstandingPaise}
                    cashSettlements={r.cashSettlements}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </AppShell>
  );
}
