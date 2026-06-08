import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { PageShell } from "@/components/PageShell";
import { SpendPeriodPicker } from "@/components/spend/SpendPeriodPicker";
import { Alert } from "@/components/ui/Alert";
import { MetricHero } from "@/components/ui/MetricHero";
import { Section } from "@/components/ui/Section";
import { Stat } from "@/components/ui/Stat";
import {
  DataTable,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from "@/components/ui/DataTable";
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
  const account = await getOrCreateAccountForBank(user.id, "bob");

  const [resolved, statements] = await Promise.all([
    resolveSpendPeriod(account.id, sp),
    listStatementPeriods(account.id),
  ]);
  const { period } = resolved;

  const [openReceivables, openPayables, categories, personRows] =
    await Promise.all([
    loadOpenReceivablesForAccount(account.id),
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

  const txnFilters = [eq(schema.transactions.accountId, account.id)];
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
    <PageShell
      title="Reimbursements"
      description={
        <>
          Splits in the selected period. For all-time balances see{" "}
          <a className="underline" href="/people">
            People
          </a>
          .{" "}
          <a className="underline" href={spendPeriodHref(sp)}>
            Spend report
          </a>
        </>
      }
      actions={
        <PureOffsetNetSettleButton
          receivables={openReceivables}
          payables={openPayables}
          categories={categoryOptions}
          knownPersonNames={knownPersonNames}
        />
      }
    >
      <Alert variant="info" className="mt-4" title="How settlement works">
        <ol className="list-decimal space-y-1 pl-4">
          <li>
            <strong className="font-medium">Bank inflow</strong> — link the
            payment to a split on{" "}
            <a className="underline" href="/transactions">
              Transactions
            </a>
            .
          </li>
          <li>
            <strong className="font-medium">Cash payback</strong> — record it
            here on an open split or in the table below.
          </li>
          <li>
            <strong className="font-medium">Net settle</strong> — offset what
            someone owes you against what you owe them (GPay-style).
          </li>
        </ol>
      </Alert>

      <SpendPeriodPicker
        resolved={resolved}
        sp={sp}
        basePath="/reimbursements"
        statementPeriods={statements}
      />

      <MetricHero
        label={`Outstanding · ${period.label}`}
        value={formatPaise(totalOutstanding)}
        tone={totalOutstanding > 0 ? "debit" : "neutral"}
        meta={
          <span>
            {outstanding.length} participant
            {outstanding.length === 1 ? "" : "s"} across {splitsRaw.length}{" "}
            split{splitsRaw.length === 1 ? "" : "s"}
          </span>
        }
      />

      {buckets.size > 0 && (
        <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          {["0–7 days", "8–30 days", "31–60 days", "60+ days"].map((label) => {
            const b = buckets.get(label);
            return (
              <Stat
                key={label}
                label={label}
                value={b ? formatPaise(b.total) : "—"}
                sub={b ? `${b.count} pending` : "none"}
                tone={b && b.total > 0 ? "receivable" : "default"}
              />
            );
          })}
        </section>
      )}

      {byPerson.length > 0 && (
        <Section
          title="By person"
          description="Who owes you the most in this period."
          className="mt-8"
        >
          <DataTable>
            <DataTableHead>
              <tr>
                <DataTableHeaderCell>Person</DataTableHeaderCell>
                <DataTableHeaderCell align="right">Outstanding</DataTableHeaderCell>
                <DataTableHeaderCell align="right">Open splits</DataTableHeaderCell>
              </tr>
            </DataTableHead>
            <tbody>
              {byPerson.map((p) => (
                <DataTableRow key={p.groupKey}>
                  <DataTableCell className="font-medium">
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
                  </DataTableCell>
                  <DataTableCell
                    align="right"
                    className="font-mono text-sm text-receivable"
                  >
                    {formatPaise(p.outstandingPaise)}
                  </DataTableCell>
                  <DataTableCell align="right" className="text-xs text-neutral-500">
                    {p.openCount}
                  </DataTableCell>
                </DataTableRow>
              ))}
            </tbody>
          </DataTable>
        </Section>
      )}

      {openSplits.length > 0 && (
        <Section
          title="Splits awaiting reimbursement"
          description="Expand a split to see who still owes you and record cash paybacks."
          className="mt-8"
        >
          <ul className="space-y-2">
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
        </Section>
      )}

      {settledSplits.length > 0 && (
        <Section
          title={`Fully settled splits (${settledSplits.length})`}
          className="mt-8"
        >
          <ul className="mt-2 space-y-1 text-xs text-neutral-500">
            {settledSplits.map((s) => (
              <li key={s.splitId} className="flex flex-wrap items-center gap-2">
                <span className="text-emerald-700 dark:text-emerald-400">
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
        </Section>
      )}

      <Section
        title="All outstanding participants"
        description="Full list sorted by age. Use Record cash for offline paybacks."
        className="mt-8"
      >
        {outstanding.length === 0 ? (
          <p className="text-sm text-neutral-500">
            Nothing pending. {rows.length === 0 && "No splits recorded yet."}
          </p>
        ) : (
          <DataTable>
            <DataTableHead>
              <tr>
                <DataTableHeaderCell>Person</DataTableHeaderCell>
                <DataTableHeaderCell>Split</DataTableHeaderCell>
                <DataTableHeaderCell align="right">Expected</DataTableHeaderCell>
                <DataTableHeaderCell align="right">Settled</DataTableHeaderCell>
                <DataTableHeaderCell align="right">Outstanding</DataTableHeaderCell>
                <DataTableHeaderCell align="right">Age</DataTableHeaderCell>
                <DataTableHeaderCell align="right">Action</DataTableHeaderCell>
              </tr>
            </DataTableHead>
            <tbody>
              {outstanding
                .slice()
                .sort((a, b) => b.ageDays - a.ageDays)
                .map((r) => (
                  <DataTableRow key={r.participantId}>
                    <DataTableCell className="font-medium">
                      {r.personName}
                    </DataTableCell>
                    <DataTableCell className="text-xs text-neutral-500">
                      {formatDate(r.txnDate)} · {r.txnDescription}
                    </DataTableCell>
                    <DataTableCell align="right" className="font-mono text-xs">
                      {formatPaise(r.expectedPaise)}
                    </DataTableCell>
                    <DataTableCell
                      align="right"
                      className="font-mono text-xs text-neutral-500"
                    >
                      <div>{formatPaise(r.settledPaise)}</div>
                      {(r.bankSettledPaise > 0 || r.cashSettledPaise > 0) && (
                        <div className="mt-0.5 font-sans text-[10px]">
                          {r.bankSettledPaise > 0 &&
                            `${formatPaise(r.bankSettledPaise)} bank`}
                          {r.bankSettledPaise > 0 &&
                            r.cashSettledPaise > 0 &&
                            " · "}
                          {r.cashSettledPaise > 0 &&
                            `${formatPaise(r.cashSettledPaise)} cash`}
                        </div>
                      )}
                    </DataTableCell>
                    <DataTableCell
                      align="right"
                      className="font-mono text-sm text-receivable"
                    >
                      {formatPaise(r.outstandingPaise)}
                    </DataTableCell>
                    <DataTableCell align="right" className="text-xs text-neutral-500">
                      {r.ageDays}d
                    </DataTableCell>
                    <DataTableCell align="right">
                      <CashSettlementButton
                        splitParticipantId={r.participantId}
                        personName={r.personName}
                        outstandingPaise={r.outstandingPaise}
                        cashSettlements={r.cashSettlements}
                      />
                    </DataTableCell>
                  </DataTableRow>
                ))}
            </tbody>
          </DataTable>
        )}
      </Section>

      {settled.length > 0 && (
        <Section title={`Settled (${settled.length})`} className="mt-10">
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
        </Section>
      )}
    </PageShell>
  );
}
