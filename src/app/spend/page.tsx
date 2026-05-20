import { getOrCreateAccountForBank } from "@/db/money-account";
import { backfillCounterparties } from "@/db/counterparty-backfill";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { AppNav } from "@/components/AppNav";
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
    <main className="mx-auto max-w-5xl p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Spend report</h1>
        <AppNav current="/spend" />
      </header>

      <p className="mt-1 text-xs text-neutral-500">
        What you actually spent, what you fronted for others, and what came back.
      </p>

      <SpendPeriodPicker
        resolved={resolved}
        sp={sp}
        statementPeriods={statements}
      />

      <section className="mt-8">
        <div className="text-xs uppercase tracking-wide text-neutral-500">
          Net personal spend
        </div>
        <div
          className={`mt-1 font-mono text-5xl ${
            totals.netSelfPaise >= 0
              ? "text-red-700 dark:text-red-400"
              : "text-emerald-700 dark:text-emerald-400"
          }`}
        >
          {formatPaise(Math.abs(totals.netSelfPaise))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
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
              className="text-amber-700 underline dark:text-amber-400"
              href={reimbQuery ? `/reimbursements?${reimbQuery}` : "/reimbursements"}
            >
              {formatPaise(reimbursement.outstandingReimbursePaise)} still owed
              from this period
            </a>
          )}
        </div>
      </section>

      <section className="mt-8 rounded border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">Spend breakdown</h2>
        <div className="mt-3">
          <SpendBreakdown
            bridge={bridge}
            netSelfPaise={totals.netSelfPaise}
            reimbursement={reimbursement}
          />
        </div>
      </section>

      {daily.length >= 2 && (
        <section className="mt-8 rounded border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-semibold">Daily spend</h2>
          <div className="mt-3">
            <DailySpendChart points={daily} />
          </div>
        </section>
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
                <span className="font-mono text-xs whitespace-nowrap text-red-700 dark:text-red-400">
                  {formatPaise(d.netSelfPaise)}
                </span>
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
        <div className="mt-3 overflow-x-auto">
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
                        <span className="text-amber-700 dark:text-amber-400">
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
    </main>
  );
}

function PeriodDelta({
  delta,
  previousLabel,
}: {
  delta: number;
  previousLabel?: string;
}) {
  if (delta === 0) {
    return (
      <span>
        Same as previous period
        {previousLabel ? ` (${previousLabel})` : ""}
      </span>
    );
  }
  const up = delta > 0;
  return (
    <span
      className={
        up
          ? "text-red-700 dark:text-red-400"
          : "text-emerald-700 dark:text-emerald-400"
      }
    >
      {up ? "+" : "−"}
      {formatPaise(Math.abs(delta))} vs previous
      {previousLabel ? ` (${previousLabel})` : " period"}
    </span>
  );
}
