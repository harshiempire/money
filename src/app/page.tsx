import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { backfillCounterparties } from "@/db/counterparty-backfill";
import { AppNav } from "@/components/AppNav";
import { SpendBreakdown } from "@/components/spend/SpendBreakdown";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import {
  categoryBreakdown,
  netSpendTotals,
  splitBridgeTotals,
  topCounterparties,
  triageStats,
} from "@/domain/spend/net";
import { reimbursementBridgeTotals } from "@/domain/spend/reimbursements";
import {
  inclusiveDayCount,
  previousPeriodWindow,
  resolvePeriod,
  PRESET_PERIODS,
} from "@/lib/period";
import { spendPeriodHref } from "@/lib/spend/period";
import { formatPaise } from "@/lib/format";

export const dynamic = "force-dynamic";

interface SP {
  from?: string;
  to?: string;
  preset?: string;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const user = await requireCurrentUser();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const userId = user.id;
  await ensureDefaultCategories(userId);
  await backfillCounterparties(account.id, userId);

  const isStatementMode = !sp.preset && !sp.from && !sp.to;

  let period = resolvePeriod(sp);
  if (isStatementMode) {
    const [latest] = await db
      .select({
        periodStart: schema.imports.periodStart,
        periodEnd: schema.imports.periodEnd,
      })
      .from(schema.imports)
      .where(eq(schema.imports.accountId, account.id))
      .orderBy(desc(schema.imports.createdAt))
      .limit(1);
    if (latest?.periodStart && latest?.periodEnd) {
      period = {
        from: latest.periodStart,
        to: latest.periodEnd,
        label: `${latest.periodStart} → ${latest.periodEnd}`,
      };
    }
  }

  const spendLink = spendPeriodHref(
    sp.preset
      ? { preset: sp.preset }
      : period.from && period.to
        ? { from: period.from, to: period.to }
        : {},
  );

  const [totals, bridge, reimbursement, triage, cats, tops, prevTotals] =
    await Promise.all([
      netSpendTotals(account.id, period.from, period.to),
      splitBridgeTotals(account.id, period.from, period.to),
      reimbursementBridgeTotals(account.id, period.from, period.to),
      triageStats(account.id, period.from, period.to),
      categoryBreakdown(account.id, period.from, period.to),
      topCounterparties(account.id, period.from, period.to, 8),
      loadPreviousPeriodTotals(account.id, period, isStatementMode),
    ]);

  const spendCats = cats.filter((c) => c.netSelfPaise > 0);
  const refundCats = cats.filter((c) => c.netSelfPaise < 0);
  const totalSpendPaise = spendCats.reduce((s, c) => s + c.netSelfPaise, 0);
  const maxSpend = spendCats[0]?.netSelfPaise ?? 1;

  const dayCount =
    period.from && period.to
      ? inclusiveDayCount(period.from, period.to)
      : null;
  const burnPerDay =
    dayCount != null && totals.netSelfPaise > 0
      ? Math.round(totals.netSelfPaise / dayCount)
      : null;

  const periodDelta =
    prevTotals != null ? totals.netSelfPaise - prevTotals.netSelfPaise : null;

  const showTriage =
    triage.uncategorizedCount > 0 || triage.needsReviewCount > 0;

  const showBreakdown =
    bridge.personalDebitGrossPaise > 0 || bridge.netCreditPaise > 0;

  return (
    <main className="mx-auto max-w-5xl p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Money</h1>
        <AppNav current="/" />
      </header>

      <PeriodPicker period={period} active={sp.preset} />

      <section className="mt-8">
        <div className="text-xs uppercase tracking-wide text-neutral-500">
          Net personal spend · {period.label}
        </div>
        <div
          className={`mt-1 font-mono text-5xl ${
            totals.netSelfPaise >= 0
              ? "text-red-700 dark:text-red-400"
              : "text-emerald-700 dark:text-emerald-400"
          }`}
        >
          {formatPaise(Math.abs(totals.netSelfPaise))}
          {totals.netSelfPaise < 0 && (
            <span className="ml-2 text-base text-emerald-700 dark:text-emerald-400">
              (net inflow)
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
          {periodDelta != null && <PeriodDelta delta={periodDelta} />}
          {burnPerDay != null && (
            <span>
              ~{formatPaise(burnPerDay)}/day over {dayCount} day
              {dayCount === 1 ? "" : "s"}
            </span>
          )}
          <span>
            {totals.count} transaction{totals.count === 1 ? "" : "s"}
          </span>
        </div>
      </section>

      {showTriage && (
        <section className="mt-6 rounded border border-amber-200 bg-amber-50/60 p-4 text-sm dark:border-amber-900/50 dark:bg-amber-950/20">
          <h2 className="font-medium text-amber-900 dark:text-amber-200">
            Needs attention
          </h2>
          <ul className="mt-2 space-y-1 text-amber-800 dark:text-amber-300/90">
            {triage.uncategorizedCount > 0 && (
              <li>
                <a className="underline" href="/transactions">
                  {triage.uncategorizedCount} uncategorized
                </a>
                {triage.uncategorizedNetSelfPaise !== 0 && (
                  <span className="font-mono text-xs">
                    {" "}
                    · {formatPaise(Math.abs(triage.uncategorizedNetSelfPaise))}{" "}
                    net
                  </span>
                )}
              </li>
            )}
            {triage.needsReviewCount > 0 && (
              <li>
                <a className="underline" href="/review">
                  {triage.needsReviewCount} flagged for review
                </a>
              </li>
            )}
          </ul>
        </section>
      )}

      {showBreakdown && (
        <section className="mt-8 rounded border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold">Spend breakdown</h2>
            <a
              href={spendLink}
              className="text-xs text-neutral-500 underline-offset-2 hover:underline"
            >
              Full report →
            </a>
          </div>
          <div className="mt-3">
            <SpendBreakdown
              bridge={bridge}
              netSelfPaise={totals.netSelfPaise}
              reimbursement={reimbursement}
              compact
            />
          </div>
        </section>
      )}

      <section className="mt-10 grid gap-8 md:grid-cols-2">
        <div>
          <h2 className="text-lg font-semibold">By category</h2>
          {spendCats.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">
              Nothing categorized yet — head to{" "}
              <a className="underline" href="/transactions">
                /transactions
              </a>{" "}
              to tag rows.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {spendCats.map((c) => (
                <li key={c.categoryName} className="text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{c.categoryName}</span>
                    <span className="font-mono text-xs whitespace-nowrap">
                      {formatPaise(c.netSelfPaise)}
                      {totalSpendPaise > 0 && (
                        <span className="text-neutral-500">
                          {" "}
                          ·{" "}
                          {((c.netSelfPaise / totalSpendPaise) * 100).toFixed(
                            0,
                          )}
                          %
                        </span>
                      )}
                      <span className="text-neutral-500"> · {c.count}</span>
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
                    <div
                      className="h-full bg-red-500/70 dark:bg-red-400/70"
                      style={{
                        width: `${Math.max(2, (c.netSelfPaise / maxSpend) * 100).toFixed(1)}%`,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
          {refundCats.length > 0 && (
            <>
              <h3 className="mt-6 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                Inflows reducing net
              </h3>
              <ul className="mt-2 space-y-1 text-sm">
                {refundCats.map((c) => (
                  <li
                    key={c.categoryName}
                    className="flex items-baseline justify-between"
                  >
                    <span>{c.categoryName}</span>
                    <span className="font-mono text-xs text-emerald-700 dark:text-emerald-400">
                      −{formatPaise(Math.abs(c.netSelfPaise))}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div>
          <h2 className="text-lg font-semibold">Top counterparties</h2>
          {tops.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">
              No counterparty spend in this period.
            </p>
          ) : (
            <ul className="mt-3 space-y-1.5 text-sm">
              {tops.map((t) => (
                <li
                  key={t.counterpartyId}
                  className="flex items-baseline justify-between gap-3"
                >
                  <span className="truncate">{t.displayName}</span>
                  <span className="font-mono text-xs whitespace-nowrap">
                    {formatPaise(t.netSelfPaise)}{" "}
                    <span className="text-neutral-500">· {t.count}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}

async function loadPreviousPeriodTotals(
  accountId: string,
  period: { from: string | null; to: string | null },
  isStatementMode: boolean,
) {
  if (!period.from || !period.to) return null;

  let prevFrom = period.from;
  let prevTo = period.to;

  if (isStatementMode) {
    const imports = await db
      .select({
        periodStart: schema.imports.periodStart,
        periodEnd: schema.imports.periodEnd,
      })
      .from(schema.imports)
      .where(eq(schema.imports.accountId, accountId))
      .orderBy(desc(schema.imports.createdAt));

    const idx = imports.findIndex(
      (i) => i.periodStart === period.from && i.periodEnd === period.to,
    );
    const prev =
      idx >= 0 ? imports[idx + 1] : imports.length > 1 ? imports[1] : null;
    if (prev?.periodStart && prev?.periodEnd) {
      prevFrom = prev.periodStart;
      prevTo = prev.periodEnd;
    } else {
      const shifted = previousPeriodWindow(period.from, period.to);
      prevFrom = shifted.from;
      prevTo = shifted.to;
    }
  } else {
    const shifted = previousPeriodWindow(period.from, period.to);
    prevFrom = shifted.from;
    prevTo = shifted.to;
  }

  return netSpendTotals(accountId, prevFrom, prevTo);
}

function PeriodDelta({ delta }: { delta: number }) {
  if (delta === 0) {
    return <span>Same as previous period</span>;
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
      {formatPaise(Math.abs(delta))} vs previous period
    </span>
  );
}

function PeriodPicker({
  period,
  active,
}: {
  period: { label: string };
  active?: string;
}) {
  const presets = Object.entries(PRESET_PERIODS).map(([key, fn]) => ({
    key,
    ...fn(),
  }));
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
      <span className="text-xs uppercase text-neutral-500">Period:</span>
      <span className="font-mono text-xs text-neutral-700 dark:text-neutral-300">
        {period.label}
      </span>
      <div className="ml-auto flex gap-1.5">
        <a
          href="/"
          className={`rounded border px-2 py-1 text-xs ${
            !active
              ? "border-neutral-900 dark:border-neutral-100"
              : "border-neutral-300 dark:border-neutral-700"
          }`}
        >
          Statement period
        </a>
        {presets.map((p) => (
          <a
            key={p.key}
            href={`/?preset=${p.key}`}
            className={`rounded border px-2 py-1 text-xs ${
              active === p.key
                ? "border-neutral-900 dark:border-neutral-100"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            {p.label}
          </a>
        ))}
        <a
          href="/spend"
          className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
        >
          Spend report
        </a>
      </div>
    </div>
  );
}
