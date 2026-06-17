import { getOrCreateAccountForBank } from "@/db/money-account";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { AppShell } from "@/components/AppShell";
import { DailySpendChart } from "@/components/spend/DailySpendChart";
import { SpendBreakdown } from "@/components/spend/SpendBreakdown";
import { SpendPeriodPicker } from "@/components/spend/SpendPeriodPicker";
import { StatHero, SectionCard, Money, PeriodDelta } from "@/components/ui";
import { monthlySpendHistory } from "@/domain/spend/monthly-history";
import {
  categoryBreakdown,
  dailyNetSpend,
  loadPeriodTxnMetrics,
  netSpendTotals,
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
  const userId = user.id;
  const account = await getOrCreateAccountForBank(userId, "bob");
  await ensureDefaultCategories(userId);

  const resolved = await resolveSpendPeriod(account.id, sp);
  const { period } = resolved;
  const periodQuery = spendPeriodHref(sp).replace("/spend?", "");
  const reimbQuery = reimbursementsPeriodHref(sp).replace("/reimbursements?", "");

  const [
    metrics,
    reimbursement,
    cats,
    debits,
    daily,
    history,
    statements,
    prevTotals,
  ] = await Promise.all([
    loadPeriodTxnMetrics(account.id, period.from, period.to, userId),
    reimbursementBridgeTotals(account.id, period.from, period.to, userId),
    categoryBreakdown(account.id, period.from, period.to, userId),
    topDebits(account.id, period.from, period.to, 8, userId),
    dailyNetSpend(account.id, period.from, period.to, userId),
    monthlySpendHistory(account.id, 12, userId),
    listStatementPeriods(account.id),
    period.from && period.to
      ? (async () => {
          const p = previousPeriodWindow(period.from!, period.to!);
          const totals = await netSpendTotals(account.id, p.from, p.to, userId);
          return { totals, label: p.label };
        })()
      : null,
  ]);

  const totals = {
    totalDebitPaise: metrics.totalDebitPaise,
    totalCreditPaise: metrics.totalCreditPaise,
    netSelfPaise: metrics.txnNetSelfPaise + metrics.owedSelfPaise,
    owedSelfPaise: metrics.owedSelfPaise,
    count: metrics.count,
  };
  const bridge = {
    personalDebitGrossPaise: metrics.personalDebitGrossPaise,
    yourShareDebitPaise: metrics.yourShareDebitPaise,
    othersSharePaise: metrics.othersSharePaise,
    netCreditPaise: metrics.netCreditPaise,
    splitTxnCount: metrics.splitTxnCount,
  };

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
    <AppShell title="Spend report">
      <p className="mt-1 text-xs text-neutral-500">
        What you actually spent, what you fronted for others, and what came back.
      </p>

      <SpendPeriodPicker
        resolved={resolved}
        sp={sp}
        statementPeriods={statements}
      />

      <StatHero
        label="Net personal spend"
        valuePaise={totals.netSelfPaise}
        tone={totals.netSelfPaise >= 0 ? "spend" : "inflow"}
      >
        {periodDelta != null && (
          <PeriodDelta delta={periodDelta} previousLabel={prevTotals?.label} />
        )}
        {dayCount != null && totals.netSelfPaise > 0 && (
          <span>
            ~{formatPaise(Math.round(totals.netSelfPaise / dayCount))}/day
          </span>
        )}
        {reimbursement.outstandingReimbursePaise > 0 && (
          <a
            className="text-owed-to-me underline"
            href={reimbQuery ? `/reimbursements?${reimbQuery}` : "/reimbursements"}
          >
            {formatPaise(reimbursement.outstandingReimbursePaise)} still owed
            from this period
          </a>
        )}
        {reimbursement.outstandingPayablePaise > 0 && (
          <a className="text-i-owe underline" href="/people">
            {formatPaise(reimbursement.outstandingPayablePaise)} you owe others
            (this period)
          </a>
        )}
        {totals.owedSelfPaise > 0 && (
          <span className="text-neutral-500">
            Includes {formatPaise(totals.owedSelfPaise)} from shared expenses
            others paid
          </span>
        )}
      </StatHero>

      <SectionCard className="mt-8" title="Spend breakdown">
        <SpendBreakdown
          bridge={bridge}
          netSelfPaise={totals.netSelfPaise}
          owedSelfPaise={totals.owedSelfPaise}
          reimbursement={reimbursement}
        />
      </SectionCard>

      {daily.length >= 2 && (
        <SectionCard className="mt-8" title="Daily spend">
          <DailySpendChart points={daily} />
        </SectionCard>
      )}

      {spendCats.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">By category</h2>
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
        </section>
      )}

      {debits.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Biggest expenses</h2>
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
                <Money value={d.netSelfPaise} tone="spend" className="text-xs" />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Monthly history</h2>
        <p className="mt-0.5 text-xs text-neutral-500">
          Last 12 calendar months. Click a row to open that month.
        </p>
        <div className="mt-3 hidden overflow-x-auto md:block">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
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
                    className={`border-t border-neutral-200 dark:border-neutral-800 ${
                      isCurrent ? "bg-neutral-50 dark:bg-neutral-900/40" : ""
                    }`}
                  >
                    <td className="py-2 pr-3">
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
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs">
                      {formatPaise(row.netSelfPaise)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs text-neutral-600 dark:text-neutral-400">
                      {formatPaise(row.yourShareDebitPaise)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs text-neutral-600 dark:text-neutral-400">
                      {row.othersSharePaise > 0
                        ? formatPaise(row.othersSharePaise)
                        : "—"}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs">
                      {row.outstandingReimbursePaise > 0 ? (
                        <Money
                          value={row.outstandingReimbursePaise}
                          tone="owed-to-me"
                        />
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
        <ul className="mt-3 space-y-2 md:hidden">
          {history.map((row) => {
            const isCurrent =
              resolved.monthKey === row.monthKey &&
              resolved.mode === "month";
            return (
              <li
                key={row.monthKey}
                className={`rounded border border-neutral-200 p-3 dark:border-neutral-800 ${
                  isCurrent ? "bg-neutral-50 dark:bg-neutral-900/40" : ""
                }`}
              >
                <a
                  href={spendPeriodHref({ month: row.monthKey })}
                  className="font-medium hover:underline"
                >
                  {row.label}
                  {row.isPartial && (
                    <span className="ml-1 text-xs font-normal text-neutral-500">
                      (partial)
                    </span>
                  )}
                </a>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                  <div>
                    <dt className="text-neutral-500">Net</dt>
                    <dd className="font-mono">{formatPaise(row.netSelfPaise)}</dd>
                  </div>
                  <div>
                    <dt className="text-neutral-500">Your share</dt>
                    <dd className="font-mono text-neutral-600 dark:text-neutral-400">
                      {formatPaise(row.yourShareDebitPaise)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-neutral-500">Fronted</dt>
                    <dd className="font-mono text-neutral-600 dark:text-neutral-400">
                      {row.othersSharePaise > 0
                        ? formatPaise(row.othersSharePaise)
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-neutral-500">Still owed</dt>
                    <dd className="font-mono">
                      {row.outstandingReimbursePaise > 0 ? (
                        <Money
                          value={row.outstandingReimbursePaise}
                          tone="owed-to-me"
                        />
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ul>
      </section>

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
    </AppShell>
  );
}

