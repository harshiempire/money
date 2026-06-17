import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { getAllAccountsForUser } from "@/db/money-account";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { backfillCounterparties } from "@/db/counterparty-backfill";
import { AppShell } from "@/components/AppShell";
import { SpendBreakdown } from "@/components/spend/SpendBreakdown";
import { StatHero, SectionCard, Bar, Money, PeriodDelta } from "@/components/ui";
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
  const accounts = await getAllAccountsForUser(user.id);
  const accountIds = accounts.map((a) => a.id);
  const userId = user.id;
  await ensureDefaultCategories(userId);
  await backfillCounterparties(accountIds, userId);

  const isStatementMode = !sp.preset && !sp.from && !sp.to;

  let period = resolvePeriod(sp);
  if (isStatementMode && accountIds.length > 0) {
    const [latest] = await db
      .select({
        periodStart: schema.imports.periodStart,
        periodEnd: schema.imports.periodEnd,
      })
      .from(schema.imports)
      .where(inArray(schema.imports.accountId, accountIds))
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

  const [totals, bridge, reimbursement, triage, cats, tops, prevComparison] =
    await Promise.all([
      netSpendTotals(accountIds, period.from, period.to, userId),
      splitBridgeTotals(accountIds, period.from, period.to),
      reimbursementBridgeTotals(accountIds, userId, period.from, period.to),
      triageStats(accountIds, period.from, period.to),
      categoryBreakdown(accountIds, period.from, period.to, userId),
      topCounterparties(accountIds, period.from, period.to, 8),
      loadPreviousPeriodComparison(accountIds, userId, period, isStatementMode),
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
    prevComparison != null
      ? totals.netSelfPaise - prevComparison.totals.netSelfPaise
      : null;

  const showTriage =
    triage.uncategorizedCount > 0 || triage.needsReviewCount > 0;

  const showBreakdown =
    bridge.personalDebitGrossPaise > 0 || bridge.netCreditPaise > 0;
  const isEmptyTenant = totals.count === 0 && cats.length === 0;

  return (
    <AppShell title="Money">
      <PeriodPicker period={period} active={sp.preset} />

      <StatHero
        label={<>Net personal spend · {period.label}</>}
        valuePaise={totals.netSelfPaise}
        tone={totals.netSelfPaise >= 0 ? "spend" : "inflow"}
        suffix={
          totals.netSelfPaise < 0 ? (
            <span className="ml-2 text-base text-inflow">(net inflow)</span>
          ) : undefined
        }
      >
        {periodDelta != null && (
          <PeriodDelta
            delta={periodDelta}
            previousLabel={prevComparison?.label}
          />
        )}
        {burnPerDay != null && (
          <span>
            ~{formatPaise(burnPerDay)}/day over {dayCount} day
            {dayCount === 1 ? "" : "s"}
          </span>
        )}
        <span>
          {totals.count} transaction{totals.count === 1 ? "" : "s"}
        </span>
      </StatHero>

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

      {isEmptyTenant ? (
        <SectionCard className="mt-8" title="No transactions yet">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Import a bank statement to see your spend breakdown and categories
            here.
          </p>
          <a
            href="/import"
            className="mt-3 inline-block rounded bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            Import statement →
          </a>
        </SectionCard>
      ) : (
        <>
          {showBreakdown && (
            <SectionCard
              className="mt-8"
              title="Spend breakdown"
              action={
                <a
                  href={spendLink}
                  className="text-xs text-neutral-500 underline-offset-2 hover:underline"
                >
                  Full report →
                </a>
              }
            >
              <SpendBreakdown
                bridge={bridge}
                netSelfPaise={totals.netSelfPaise}
                owedSelfPaise={totals.owedSelfPaise}
                reimbursement={reimbursement}
                compact
              />
            </SectionCard>
          )}

          <section className="mt-10 grid gap-8 md:grid-cols-2">
        <div>
          <h2 className="text-lg font-semibold">By category</h2>
          {totalSpendPaise > 0 && (
            <p className="mt-0.5 text-xs text-neutral-500">
              % of net personal spend in this period
            </p>
          )}
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
                  <Bar value={c.netSelfPaise} max={maxSpend} className="mt-1" />
                </li>
              ))}
            </ul>
          )}
          {refundCats.length > 0 && (
            <>
              <h3 className="mt-6 text-sm font-medium text-inflow">
                Inflows reducing net
              </h3>
              <ul className="mt-2 space-y-1 text-sm">
                {refundCats.map((c) => (
                  <li
                    key={c.categoryName}
                    className="flex items-baseline justify-between"
                  >
                    <span>{c.categoryName}</span>
                    <Money
                      value={c.netSelfPaise}
                      tone="inflow"
                      signed
                      className="text-xs"
                    />
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
        </>
      )}
    </AppShell>
  );
}

async function loadPreviousPeriodComparison(
  accountIds: string[],
  userId: string,
  period: { from: string | null; to: string | null },
  isStatementMode: boolean,
) {
  if (!period.from || !period.to) return null;

  let prevFrom = period.from;
  let prevTo = period.to;
  let label = `${prevFrom} → ${prevTo}`;

  if (isStatementMode && accountIds.length > 0) {
    const imports = await db
      .select({
        periodStart: schema.imports.periodStart,
        periodEnd: schema.imports.periodEnd,
      })
      .from(schema.imports)
      .where(inArray(schema.imports.accountId, accountIds))
      .orderBy(desc(schema.imports.createdAt));

    const idx = imports.findIndex(
      (i) => i.periodStart === period.from && i.periodEnd === period.to,
    );
    const prev =
      idx >= 0 ? imports[idx + 1] : imports.length > 1 ? imports[1] : null;
    if (prev?.periodStart && prev?.periodEnd) {
      prevFrom = prev.periodStart;
      prevTo = prev.periodEnd;
      label = `${prevFrom} → ${prevTo}`;
    } else {
      const shifted = previousPeriodWindow(period.from, period.to);
      prevFrom = shifted.from;
      prevTo = shifted.to;
      label = shifted.label;
    }
  } else {
    const shifted = previousPeriodWindow(period.from, period.to);
    prevFrom = shifted.from;
    prevTo = shifted.to;
    label = shifted.label;
  }

  const totals = await netSpendTotals(accountIds, prevFrom, prevTo, userId);
  return { totals, label };
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
