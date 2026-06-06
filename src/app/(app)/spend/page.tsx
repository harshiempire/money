import Link from "next/link";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { backfillCounterparties } from "@/db/counterparty-backfill";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { DailySpendChart } from "@/components/spend/DailySpendChart";
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
import { counterpartyLabel, formatDate, formatPaise } from "@/lib/format";
import { inclusiveDayCount, previousPeriodWindow } from "@/lib/period";
import {
  listStatementPeriods,
  reimbursementsPeriodHref,
  resolveSpendPeriod,
  spendPeriodHref,
  type SpendSearchParams,
} from "@/lib/spend/period";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { PeriodDelta } from "@/components/ui/PeriodDelta";
import { cn } from "@/lib/cn";

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
    <>
      <PageHeader
        title="Spend report"
        description="What you actually spent, what you fronted for others, and what came back"
      />

      <SpendPeriodPicker
        resolved={resolved}
        sp={sp}
        statementPeriods={statements}
      />

      <Card className="mt-6 overflow-hidden" padding="none">
        <div className="bg-gradient-to-br from-[var(--color-accent-muted)]/50 to-transparent p-6">
          <div className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-secondary)]">
            Net personal spend
          </div>
          <div className="mt-2">
            <Money paise={totals.netSelfPaise} signed size="hero" />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
            {periodDelta != null && (
              <PeriodDelta delta={periodDelta} previousLabel={prevTotals?.label} />
            )}
            {dayCount != null && totals.netSelfPaise > 0 && (
              <span>
                ~{formatPaise(Math.round(totals.netSelfPaise / dayCount))}/day
              </span>
            )}
            {reimbursement.outstandingReimbursePaise > 0 && (
              <Link
                href={reimbQuery ? `/reimbursements?${reimbQuery}` : "/reimbursements"}
                className="font-medium text-[var(--color-warning)] underline underline-offset-2"
              >
                {formatPaise(reimbursement.outstandingReimbursePaise)} still owed
              </Link>
            )}
            {reimbursement.outstandingPayablePaise > 0 && (
              <Link href="/people" className="font-medium text-[var(--color-info)] underline underline-offset-2">
                {formatPaise(reimbursement.outstandingPayablePaise)} you owe others
              </Link>
            )}
          </div>
        </div>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Spend breakdown" />
        <div className="mt-4">
          <SpendBreakdown
            bridge={bridge}
            netSelfPaise={totals.netSelfPaise}
            reimbursement={reimbursement}
          />
        </div>
      </Card>

      {daily.length >= 2 && (
        <Card className="mt-6">
          <CardHeader title="Daily spend" />
          <div className="mt-4">
            <DailySpendChart points={daily} />
          </div>
        </Card>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {spendCats.length > 0 && (
          <Card>
            <CardHeader
              title="By category"
              description={totalSpendPaise > 0 ? "% of net personal spend" : undefined}
            />
            <ul className="mt-4 space-y-2 text-sm">
              {spendCats.map((c) => (
                <li key={c.categoryName} className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{c.categoryName}</span>
                  <span className="font-mono text-xs text-[var(--color-text-secondary)]">
                    {formatPaise(c.netSelfPaise)}
                    {totalSpendPaise > 0 && (
                      <span className="text-[var(--color-text-muted)]">
                        {" "}· {((c.netSelfPaise / totalSpendPaise) * 100).toFixed(0)}%
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {debits.length > 0 && (
          <Card>
            <CardHeader title="Biggest expenses" />
            <ul className="mt-4 divide-y divide-[var(--color-border)]">
              {debits.map((d) => (
                <li key={d.id} className="flex items-baseline justify-between gap-3 py-2.5 text-sm first:pt-0 last:pb-0">
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-xs text-[var(--color-text-muted)]">
                      {formatDate(d.txnDate)}{" "}
                    </span>
                    {counterpartyLabel(d.rawDescription)}
                  </span>
                  <Money paise={d.netSelfPaise} size="sm" className="text-[var(--color-debit)]" />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Monthly history"
          description="Last 12 calendar months. Click a row to open that month."
        />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                <th className="py-2 pr-3">Month</th>
                <th className="py-2 pr-3 text-right">Net spend</th>
                <th className="py-2 pr-3 text-right">Your share</th>
                <th className="py-2 pr-3 text-right">Fronted</th>
                <th className="py-2 pr-3 text-right">Still owed</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => {
                const isCurrent =
                  resolved.monthKey === row.monthKey &&
                  resolved.mode === "month";
                return (
                  <tr
                    key={row.monthKey}
                    className={cn(
                      "border-t border-[var(--color-border)] transition-colors hover:bg-[var(--color-surface-overlay)]/50",
                      isCurrent && "bg-[var(--color-accent-muted)]/30",
                    )}
                  >
                    <td className="py-2.5 pr-3">
                      <Link
                        href={spendPeriodHref({ month: row.monthKey })}
                        className="font-medium hover:text-[var(--color-accent)]"
                      >
                        {row.label}
                        {row.isPartial && (
                          <span className="ml-1 text-xs text-[var(--color-text-muted)]">
                            (partial)
                          </span>
                        )}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs">
                      {formatPaise(row.netSelfPaise)}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs text-[var(--color-text-secondary)]">
                      {formatPaise(row.yourShareDebitPaise)}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs text-[var(--color-text-secondary)]">
                      {row.othersSharePaise > 0 ? formatPaise(row.othersSharePaise) : "—"}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-xs">
                      {row.outstandingReimbursePaise > 0 ? (
                        <span className="text-[var(--color-warning)]">
                          {formatPaise(row.outstandingReimbursePaise)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {periodQuery && (
        <p className="mt-6 text-sm text-[var(--color-text-muted)]">
          <Link
            href={`/transactions?${period.from ? `from=${period.from}&` : ""}${period.to ? `to=${period.to}` : ""}`}
            className="font-medium text-[var(--color-accent)] underline underline-offset-2"
          >
            View transactions in this period →
          </Link>
        </p>
      )}
    </>
  );
}
