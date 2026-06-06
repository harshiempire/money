import { getOrCreateAccountForBank } from "@/db/money-account";
import { backfillCounterparties } from "@/db/counterparty-backfill";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { PageShell } from "@/components/PageShell";
import { PeriodDelta } from "@/components/PeriodDelta";
import { DailySpendChart } from "@/components/spend/DailySpendChart";
import { Card } from "@/components/ui/Card";
import { MetricHero } from "@/components/ui/MetricHero";
import { Section } from "@/components/ui/Section";
import {
  DataTable,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  DataTableCell,
} from "@/components/ui/DataTable";
import { SpendBreakdown } from "@/components/spend/SpendBreakdown";
import { SpendPeriodPicker } from "@/components/spend/SpendPeriodPicker";
import { monthlySpendHistory } from "@/domain/spend/monthly-history";
import {
  categoryBreakdown,
  dailyNetSpend,
  netSpendTotals,
  splitBridgeTotals,
  topDebits,
} from "@/domain/spend/net";
import { reimbursementBridgeTotals } from "@/domain/spend/reimbursements";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import {
  counterpartyLabel,
  formatDate,
  formatPaise,
} from "@/lib/format";
import { inclusiveDayCount, previousPeriodWindow } from "@/lib/period";
import {
  listStatementPeriods,
  reimbursementsPeriodHref,
  resolveSpendPeriod,
  spendPeriodHref,
  type SpendSearchParams,
} from "@/lib/spend/period";

export const dynamic = "force-dynamic";

export default async function SpendReportPage({
  searchParams,
}: {
  searchParams: Promise<SpendSearchParams>;
}) {
  const sp = await searchParams;
  const user = await requireCurrentUser();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  await ensureDefaultCategories(user.id);
  await backfillCounterparties(account.id, user.id);

  const resolved = await resolveSpendPeriod(account.id, sp);
  const { period } = resolved;
  const periodQuery = spendPeriodHref(sp).replace("/spend?", "");
  const reimbQuery = reimbursementsPeriodHref(sp).replace("/reimbursements?", "");

  const [
    totals,
    bridge,
    reimbursement,
    cats,
    debits,
    daily,
    history,
    statements,
    prevTotals,
  ] = await Promise.all([
    netSpendTotals(account.id, period.from, period.to),
    splitBridgeTotals(account.id, period.from, period.to),
    reimbursementBridgeTotals(account.id, period.from, period.to),
    categoryBreakdown(account.id, period.from, period.to),
    topDebits(account.id, period.from, period.to, 8),
    dailyNetSpend(account.id, period.from, period.to),
    monthlySpendHistory(account.id, 12),
    listStatementPeriods(account.id),
    period.from && period.to
      ? (async () => {
          const p = previousPeriodWindow(period.from!, period.to!);
          const totals = await netSpendTotals(account.id, p.from, p.to);
          return { totals, label: p.label };
        })()
      : null,
  ]);

  const spendCats = cats.filter((c) => c.netSelfPaise > 0);
  const totalSpendPaise = spendCats.reduce((s, c) => s + c.netSelfPaise, 0);
  const dayCount =
    period.from && period.to
      ? inclusiveDayCount(period.from, period.to)
      : null;
  const periodDelta =
    prevTotals != null
      ? totals.netSelfPaise - prevTotals.totals.netSelfPaise
      : null;

  return (
    <PageShell
      title="Spend report"
      description="What you actually spent, what you fronted for others, and what came back."
    >
      <SpendPeriodPicker
        resolved={resolved}
        sp={sp}
        statementPeriods={statements}
      />

      <MetricHero
        label="Net personal spend"
        value={formatPaise(Math.abs(totals.netSelfPaise))}
        tone={totals.netSelfPaise >= 0 ? "debit" : "credit"}
        meta={
          <>
            {periodDelta != null && (
              <PeriodDelta
                delta={periodDelta}
                previousLabel={prevTotals?.label}
              />
            )}
            {dayCount != null && totals.netSelfPaise > 0 && (
              <span>
                ~{formatPaise(Math.round(totals.netSelfPaise / dayCount))}/day
              </span>
            )}
            {reimbursement.outstandingReimbursePaise > 0 && (
              <a
                className="text-receivable underline"
                href={
                  reimbQuery
                    ? `/reimbursements?${reimbQuery}`
                    : "/reimbursements"
                }
              >
                {formatPaise(reimbursement.outstandingReimbursePaise)} still
                owed from this period
              </a>
            )}
            {reimbursement.outstandingPayablePaise > 0 && (
              <a className="text-payable underline" href="/people">
                {formatPaise(reimbursement.outstandingPayablePaise)} you owe
                others (this period)
              </a>
            )}
            {totals.owedSelfPaise > 0 && (
              <span>
                Includes {formatPaise(totals.owedSelfPaise)} from shared
                expenses others paid
              </span>
            )}
          </>
        }
      />

      <Section title="Spend breakdown" className="mt-8">
        <Card>
          <SpendBreakdown
            bridge={bridge}
            netSelfPaise={totals.netSelfPaise}
            reimbursement={reimbursement}
          />
        </Card>
      </Section>

      {daily.length >= 2 && (
        <Section title="Daily spend" className="mt-8">
          <Card>
            <DailySpendChart points={daily} />
          </Card>
        </Section>
      )}

      {spendCats.length > 0 && (
        <Section title="By category" className="mt-8">
          {totalSpendPaise > 0 && (
            <p className="mt-0.5 text-xs text-neutral-500">
              % of net personal spend in this period
            </p>
          )}
          <ul className="mt-3 space-y-2 text-sm">
            {spendCats.map((c) => (
              <li
                key={c.categoryName}
                className="flex items-baseline justify-between gap-2"
              >
                <span className="font-medium">{c.categoryName}</span>
                <span className="font-mono text-xs whitespace-nowrap">
                  {formatPaise(c.netSelfPaise)}
                  {totalSpendPaise > 0 && (
                    <span className="text-neutral-500">
                      {" "}
                      ·{" "}
                      {((c.netSelfPaise / totalSpendPaise) * 100).toFixed(0)}%
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {debits.length > 0 && (
        <Section title="Biggest expenses" className="mt-8">
          <ul className="mt-3 space-y-1.5 text-sm">
            {debits.map((d) => (
              <li
                key={d.id}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="min-w-0 truncate">
                  <span className="font-mono text-xs text-neutral-500">
                    {formatDate(d.txnDate)}{" "}
                  </span>
                  {counterpartyLabel(d.rawDescription)}
                </span>
                <span className="font-mono text-xs whitespace-nowrap text-red-700 dark:text-red-400">
                  {formatPaise(d.netSelfPaise)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title="Monthly history"
        description="Last 12 calendar months. Click a row to open that month."
        className="mt-10"
      >
        <DataTable>
          <DataTableHead>
            <tr>
              <DataTableHeaderCell>Month</DataTableHeaderCell>
              <DataTableHeaderCell align="right">Net spend</DataTableHeaderCell>
              <DataTableHeaderCell align="right">Your share</DataTableHeaderCell>
              <DataTableHeaderCell align="right">Fronted</DataTableHeaderCell>
              <DataTableHeaderCell align="right">Still owed</DataTableHeaderCell>
            </tr>
          </DataTableHead>
          <tbody>
            {history.map((row) => {
              const isCurrent =
                resolved.monthKey === row.monthKey &&
                resolved.mode === "month";
              return (
                <DataTableRow
                  key={row.monthKey}
                  className={
                    isCurrent ? "bg-surface-muted/80" : undefined
                  }
                >
                  <DataTableCell>
                    <a
                      href={spendPeriodHref({ month: row.monthKey })}
                      className="hover:underline"
                    >
                      {row.label}
                      {row.isPartial && (
                        <span className="ml-1 text-xs text-neutral-500">
                          (partial)
                        </span>
                      )}
                    </a>
                  </DataTableCell>
                  <DataTableCell align="right" className="font-mono text-xs">
                    {formatPaise(row.netSelfPaise)}
                  </DataTableCell>
                  <DataTableCell
                    align="right"
                    className="font-mono text-xs text-neutral-600 dark:text-neutral-400"
                  >
                    {formatPaise(row.yourShareDebitPaise)}
                  </DataTableCell>
                  <DataTableCell
                    align="right"
                    className="font-mono text-xs text-neutral-600 dark:text-neutral-400"
                  >
                    {row.othersSharePaise > 0
                      ? formatPaise(row.othersSharePaise)
                      : "—"}
                  </DataTableCell>
                  <DataTableCell align="right" className="font-mono text-xs">
                    {row.outstandingReimbursePaise > 0 ? (
                      <span className="text-receivable">
                        {formatPaise(row.outstandingReimbursePaise)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </DataTableCell>
                </DataTableRow>
              );
            })}
          </tbody>
        </DataTable>
      </Section>

      {periodQuery && (
        <p className="mt-8 text-xs text-neutral-500">
          <a
            className="underline"
            href={`/transactions?${period.from ? `from=${period.from}&` : ""}${period.to ? `to=${period.to}` : ""}`}
          >
            View transactions in this period →
          </a>
        </p>
      )}
    </PageShell>
  );
}
