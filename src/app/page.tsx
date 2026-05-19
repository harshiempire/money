import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { backfillCounterparties } from "@/db/counterparty-backfill";
import { AppNav } from "@/components/AppNav";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import {
  categoryBreakdown,
  dailyNetSpend,
  netSpendTotals,
  splitBridgeTotals,
  topCounterparties,
  topDebits,
  triageStats,
} from "@/domain/spend/net";
import {
  inclusiveDayCount,
  previousPeriodWindow,
  resolvePeriod,
  PRESET_PERIODS,
} from "@/lib/period";
import {
  counterpartyLabel,
  formatDate,
  formatPaise,
  formatPaisePlain,
} from "@/lib/format";

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

  // Default to the latest imported statement period when no params given.
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

  const [
    totals,
    bridge,
    triage,
    cats,
    tops,
    debits,
    daily,
    prevTotals,
  ] = await Promise.all([
    netSpendTotals(account.id, period.from, period.to),
    splitBridgeTotals(account.id, period.from, period.to),
    triageStats(account.id, period.from, period.to),
    categoryBreakdown(account.id, period.from, period.to),
    topCounterparties(account.id, period.from, period.to, 8),
    topDebits(account.id, period.from, period.to, 5),
    dailyNetSpend(account.id, period.from, period.to),
    loadPreviousPeriodTotals(account.id, period, isStatementMode),
  ]);

  const spendCats = cats.filter((c) => c.netSelfPaise > 0);
  const refundCats = cats.filter((c) => c.netSelfPaise < 0);
  const totalSpendPaise = spendCats.reduce((s, c) => s + c.netSelfPaise, 0);
  const maxSpend = spendCats[0]?.netSelfPaise ?? 1;
  const top3 = spendCats.slice(0, 3);
  const top3Share =
    totalSpendPaise > 0
      ? top3.reduce((s, c) => s + c.netSelfPaise, 0) / totalSpendPaise
      : 0;

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
          {periodDelta != null && (
            <PeriodDelta delta={periodDelta} />
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

      {(bridge.personalDebitGrossPaise > 0 || bridge.netCreditPaise > 0) && (
        <section className="mt-8 rounded border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-semibold">Spend breakdown</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            How bank debits become your net personal spend.
          </p>
          <dl className="mt-3 space-y-1.5 font-mono text-sm">
            <BridgeRow
              label="Personal debits (gross)"
              value={bridge.personalDebitGrossPaise}
            />
            {bridge.othersSharePaise > 0 && (
              <BridgeRow
                label="Others' share (splits)"
                value={-bridge.othersSharePaise}
                tone="credit"
                hint={`${bridge.splitTxnCount} split txn${bridge.splitTxnCount === 1 ? "" : "s"}`}
              />
            )}
            <BridgeRow
              label="Your share of debits"
              value={bridge.yourShareDebitPaise}
              bold
            />
            {bridge.netCreditPaise > 0 && (
              <BridgeRow
                label="Refunds & income"
                value={-bridge.netCreditPaise}
                tone="credit"
              />
            )}
            <div className="border-t border-neutral-200 pt-1.5 dark:border-neutral-700">
              <BridgeRow
                label="Net personal spend"
                value={totals.netSelfPaise}
                bold
                tone={totals.netSelfPaise >= 0 ? "debit" : "credit"}
              />
            </div>
          </dl>
        </section>
      )}

      {daily.length >= 2 && (
        <section className="mt-8 rounded border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-semibold">Daily spend</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Net personal spend per day in this period.
          </p>
          <div className="mt-3">
            <DailySpendChart points={daily} />
          </div>
        </section>
      )}

      {top3.length > 0 && (
        <section className="mt-8 text-sm">
          <p className="text-neutral-600 dark:text-neutral-400">
            Top {top3.length} categor{top3.length === 1 ? "y" : "ies"} —{" "}
            <span className="font-mono">
              {(top3Share * 100).toFixed(0)}%
            </span>{" "}
            of spend:{" "}
            {top3
              .map(
                (c) =>
                  `${c.categoryName} (${totalSpendPaise > 0 ? ((c.netSelfPaise / totalSpendPaise) * 100).toFixed(0) : 0}%)`,
              )
              .join(" · ")}
          </p>
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

        <div className="space-y-8">
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
                      <span className="text-neutral-500">
                        · {t.count}
                        {t.count > 1 && (
                          <> · {formatPaise(Math.round(t.netSelfPaise / t.count))} avg</>
                        )}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {debits.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold">Biggest expenses</h2>
              <p className="mt-0.5 text-xs text-neutral-500">
                Top debits by your share (split-aware).
              </p>
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
            </div>
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
    <span className={up ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}>
      {up ? "+" : "−"}
      {formatPaise(Math.abs(delta))} vs previous period
    </span>
  );
}

function BridgeRow({
  label,
  value,
  tone,
  bold,
  hint,
}: {
  label: string;
  value: number;
  tone?: "debit" | "credit";
  bold?: boolean;
  hint?: string;
}) {
  const resolvedTone =
    tone ?? (value >= 0 ? "debit" : "credit");
  const toneClass =
    resolvedTone === "debit"
      ? "text-red-700 dark:text-red-400"
      : "text-emerald-700 dark:text-emerald-400";
  const prefix = value < 0 ? "−" : "";
  return (
    <div className={`flex items-baseline justify-between gap-3 ${bold ? "font-semibold" : ""}`}>
      <dt className="font-sans text-neutral-600 dark:text-neutral-400">
        {label}
        {hint && (
          <span className="ml-1 font-normal text-neutral-400">({hint})</span>
        )}
      </dt>
      <dd className={`whitespace-nowrap ${toneClass}`}>
        {prefix}
        {formatPaise(Math.abs(value))}
      </dd>
    </div>
  );
}

const svgCoord = (n: number) => Number(n.toFixed(1));

function DailySpendChart({
  points,
}: {
  points: Array<{ date: string; netSelfPaise: number }>;
}) {
  const W = 800;
  const H = 120;
  const PAD_X = 8;
  const PAD_Y = 8;
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_Y * 2;

  const ys = points.map((p) => Math.max(0, p.netSelfPaise));
  const maxY = Math.max(1, ...ys);
  const barW = innerW / points.length;
  const lastIndex = points.length - 1;
  const ticks = [0, Math.floor(points.length / 2), lastIndex].filter(
    (v, i, a) => a.indexOf(v) === i,
  );

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-28 w-full text-neutral-500"
      preserveAspectRatio="none"
    >
      {points.map((p, i) => {
        const h =
          p.netSelfPaise > 0
            ? (p.netSelfPaise / maxY) * innerH
            : 0;
        const x = svgCoord(PAD_X + i * barW + barW * 0.15);
        const w = svgCoord(barW * 0.7);
        const y = svgCoord(PAD_Y + innerH - h);
        return (
          <rect
            key={p.date}
            x={x}
            y={y}
            width={w}
            height={svgCoord(Math.max(0, h))}
            className="fill-red-500/60 dark:fill-red-400/60"
            rx={1}
          >
            <title>{`${p.date} · ${formatPaisePlain(p.netSelfPaise)}`}</title>
          </rect>
        );
      })}
      {ticks.map((i) => (
        <text
          key={points[i].date}
          x={svgCoord(PAD_X + i * barW + barW / 2)}
          y={H - 1}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor"
          opacity={0.7}
        >
          {points[i].date.slice(5)}
        </text>
      ))}
    </svg>
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
      </div>
    </div>
  );
}
