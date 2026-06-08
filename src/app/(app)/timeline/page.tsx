import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGrid } from "@/components/ui/Stat";
import { Card, CardHeader } from "@/components/ui/Card";
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
  const account = await getOrCreateAccountForBank(user.id, "bob");

  const [resolved, statementPeriods] = await Promise.all([
    resolveTimelinePeriod(account.id, sp),
    listStatementPeriods(account.id),
  ]);
  const { period } = resolved;

  const balances = await dailyClosingBalance(
    account.id,
    period.from,
    period.to,
  );

  // Biggest movers in the period: top 10 debits and credits by amount.
  const filters = [eq(schema.transactions.accountId, account.id)];
  if (period.from) filters.push(gte(schema.transactions.txnDate, period.from));
  if (period.to) filters.push(lte(schema.transactions.txnDate, period.to));
  const where = and(...filters);

  const movers = await db
    .select({
      id: schema.transactions.id,
      txnDate: schema.transactions.txnDate,
      amountPaise: schema.transactions.amountPaise,
      drCr: schema.transactions.drCr,
      rawDescription: schema.transactions.rawDescription,
      isTransfer: schema.transactions.isTransfer,
    })
    .from(schema.transactions)
    .where(where)
    .orderBy(desc(schema.transactions.amountPaise))
    .limit(15);

  const opening = balances[0]?.balancePaise ?? null;
  const closing = balances[balances.length - 1]?.balancePaise ?? null;
  const delta =
    opening != null && closing != null ? closing - opening : null;

  return (
    <>
      <PageHeader
        title="Timeline"
        description="Account balance over time and largest transactions in the period"
      />

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
          <StatGrid className="mt-6">
            <Stat label="Opening" value={formatPaise(opening ?? 0)} />
            <Stat label="Closing" value={formatPaise(closing ?? 0)} />
            <Stat
              label="Delta"
              value={
                delta == null
                  ? "—"
                  : `${delta >= 0 ? "+" : "−"} ${formatPaise(Math.abs(delta))}`
              }
              tone={delta == null ? undefined : delta >= 0 ? "credit" : "debit"}
            />
          </StatGrid>

          <Card className="mt-6">
            <BalanceChart points={balances} />
          </Card>

          <Card className="mt-6">
            <CardHeader
              title="Biggest movers"
              description="Top 15 transactions by amount in this period"
            />
            <table className="mt-4 w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
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
                    className={`border-t border-[var(--color-border)] transition-colors hover:bg-[var(--color-surface-overlay)]/30 ${
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
                          ? "text-red-700 dark:text-red-400"
                          : "text-emerald-700 dark:text-emerald-400"
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
          </Card>
        </>
      )}
    </>
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

