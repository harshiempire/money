import { and, desc, gte, inArray, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { getAllAccountsForUser } from "@/db/money-account";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { AppShell } from "@/components/AppShell";
import { SpendPeriodPicker } from "@/components/spend/SpendPeriodPicker";
import { dailyClosingBalance } from "@/domain/spend/net";
import {
  listStatementPeriods,
  resolveTimelinePeriod,
  type SpendSearchParams,
} from "@/lib/spend/period";
import {
  counterpartyLabel,
  formatDate,
  formatPaise,
  formatPaisePlain,
  formatPaiseSigned,
} from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<SpendSearchParams>;
}) {
  const sp = await searchParams;
  const user = await requireCurrentUser();
  const accounts = await getAllAccountsForUser(user.id);
  const accountIds = accounts.map((a) => a.id);

  const [resolved, statementPeriods] = await Promise.all([
    resolveTimelinePeriod(accountIds, sp),
    listStatementPeriods(accountIds),
  ]);
  const { period } = resolved;

  const balances = await dailyClosingBalance(accountIds, period.from, period.to);

  const moversFilters = accountIds.length > 0
    ? [inArray(schema.transactions.accountId, accountIds)]
    : [];
  if (period.from) moversFilters.push(gte(schema.transactions.txnDate, period.from));
  if (period.to) moversFilters.push(lte(schema.transactions.txnDate, period.to));

  const movers = accountIds.length > 0 ? await db
    .select({
      id: schema.transactions.id,
      txnDate: schema.transactions.txnDate,
      amountPaise: schema.transactions.amountPaise,
      drCr: schema.transactions.drCr,
      rawDescription: schema.transactions.rawDescription,
      isTransfer: schema.transactions.isTransfer,
    })
    .from(schema.transactions)
    .where(and(...moversFilters))
    .orderBy(desc(schema.transactions.amountPaise))
    .limit(15) : [];

  const opening = balances[0]?.balancePaise ?? null;
  const closing = balances[balances.length - 1]?.balancePaise ?? null;
  const delta =
    opening != null && closing != null ? closing - opening : null;

  return (
    <AppShell title="Timeline">
      <SpendPeriodPicker
        resolved={resolved}
        sp={sp}
        basePath="/timeline"
        statementPeriods={statementPeriods}
      />

      {balances.length === 0 ? (
        <p className="mt-10 text-sm text-neutral-500">
          No data in this period.
        </p>
      ) : (
        <>
          <section className="mt-6 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <Stat label="Opening" value={formatPaise(opening)} />
            <Stat label="Closing" value={formatPaise(closing)} />
            <Stat
              label="Delta"
              value={
                delta == null
                  ? "—"
                  : `${delta >= 0 ? "+" : "−"} ${formatPaise(Math.abs(delta))}`
              }
              tone={delta == null ? undefined : delta >= 0 ? "credit" : "debit"}
            />
          </section>

          <section className="mt-6 rounded border border-neutral-200 p-4 dark:border-neutral-800">
            <BalanceChart points={balances} />
          </section>

          <section className="mt-8">
            <h2 className="text-lg font-semibold">Biggest movers</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Top 15 transactions by amount in this period.
            </p>
            <table className="mt-3 w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Counterparty</th>
                  <th className="py-2 pr-3 text-right">Amount</th>
                  <th className="py-2 pr-3">Tag</th>
                </tr>
              </thead>
              <tbody>
                {movers.map((r) => (
                  <tr
                    key={r.id}
                    className={`border-t border-neutral-200 dark:border-neutral-800 ${
                      r.isTransfer ? "opacity-60" : ""
                    }`}
                  >
                    <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                      {formatDate(r.txnDate)}
                    </td>
                    <td className="py-2 pr-3">
                      {counterpartyLabel(r.rawDescription)}
                    </td>
                    <td
                      className={`py-2 pr-3 text-right font-mono whitespace-nowrap ${
                        r.drCr === "debit"
                          ? "text-spend"
                          : "text-inflow"
                      }`}
                    >
                      {formatPaiseSigned(r.amountPaise, r.drCr)}
                    </td>
                    <td className="py-2 pr-3 text-xs text-neutral-500">
                      {r.isTransfer ? "transfer" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </AppShell>
  );
}

/** Round SVG coords so server and client produce identical attribute strings. */
const svgCoord = (n: number) => Number(n.toFixed(1));

function BalanceChart({
  points,
}: {
  points: Array<{ date: string; balancePaise: number }>;
}) {
  const W = 800;
  const H = 260;
  const PAD_RIGHT = 12;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 32;

  if (points.length < 2) {
    return (
      <p className="text-sm text-neutral-500">
        Not enough points for a chart yet.
      </p>
    );
  }

  const ys = points.map((p) => p.balancePaise);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const yRange = Math.max(1, maxY - minY);
  const lastIndex = points.length - 1;

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((t) => minY + t * yRange);
  const yLabels = gridYs.map((v) => formatPaisePlain(Math.round(v)));
  const maxLabelChars = Math.max(...yLabels.map((s) => s.length));
  const PAD_LEFT = Math.max(64, Math.ceil(maxLabelChars * 6.5) + 12);

  const innerW = W - PAD_LEFT - PAD_RIGHT;
  const innerH = H - PAD_TOP - PAD_BOTTOM;

  const sx = (i: number) =>
    svgCoord(PAD_LEFT + (i / Math.max(1, lastIndex)) * innerW);
  const sy = (v: number) =>
    svgCoord(PAD_TOP + innerH - ((v - minY) / yRange) * innerH);

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${sx(i)} ${sy(p.balancePaise)}`)
    .join(" ");

  const ticks = [0, Math.floor(points.length / 2), lastIndex];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-64 w-full text-neutral-500"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Daily closing balance chart"
    >
      {gridYs.map((v, gi) => (
        <line
          key={gi}
          x1={PAD_LEFT}
          x2={W - PAD_RIGHT}
          y1={sy(v)}
          y2={sy(v)}
          stroke="currentColor"
          strokeWidth={0.5}
          strokeDasharray="2 4"
          opacity={0.3}
        />
      ))}
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        className="text-sky-600 dark:text-sky-400"
      />
      {points.map((p, i) => (
        <circle
          key={p.date}
          cx={sx(i)}
          cy={sy(p.balancePaise)}
          r={2}
          className="fill-sky-600 dark:fill-sky-400"
        >
          <title>{`${p.date} · ${formatPaisePlain(p.balancePaise)}`}</title>
        </circle>
      ))}
      {gridYs.map((v, gi) => (
        <text
          key={gi}
          x={PAD_LEFT - 8}
          y={sy(v)}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={10}
          className="fill-neutral-600 dark:fill-neutral-300"
        >
          {yLabels[gi]}
        </text>
      ))}
      {ticks.map((i) => (
        <text
          key={points[i].date}
          x={sx(i)}
          y={H - 10}
          textAnchor="middle"
          fontSize={10}
          className="fill-neutral-600 dark:fill-neutral-300"
        >
          {points[i].date}
        </text>
      ))}
    </svg>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "debit" | "credit";
}) {
  const toneClass =
    tone === "debit"
      ? "text-spend"
      : tone === "credit"
        ? "text-inflow"
        : "";
  return (
    <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs uppercase text-neutral-500">{label}</div>
      <div className={`mt-1 font-mono text-base ${toneClass}`}>{value}</div>
    </div>
  );
}
