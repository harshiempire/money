import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { AppNav } from "@/components/AppNav";
import { dailyClosingBalance } from "@/domain/spend/net";
import { resolvePeriod, PRESET_PERIODS } from "@/lib/period";
import {
  counterpartyLabel,
  formatDate,
  formatPaise,
  formatPaisePlain,
  formatPaiseSigned,
} from "@/lib/format";

export const dynamic = "force-dynamic";

interface SP {
  from?: string;
  to?: string;
  preset?: string;
}

export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const user = await requireCurrentUser();
  const account = await getOrCreateAccountForBank(user.id, "bob");

  let period = resolvePeriod(sp);
  if (!sp.preset && !sp.from && !sp.to) {
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
    <main className="mx-auto max-w-5xl p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Timeline</h1>
        <AppNav current="/timeline" />
      </header>

      <PeriodPicker period={period} active={sp.preset} />

      {balances.length === 0 ? (
        <p className="mt-10 text-sm text-neutral-500">
          No data in this period.
        </p>
      ) : (
        <>
          <section className="mt-6 grid grid-cols-3 gap-3 text-sm">
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
          </section>
        </>
      )}
    </main>
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
  const H = 240;
  const PAD_X = 40;
  const PAD_Y = 20;
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_Y * 2;

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

  const sx = (i: number) =>
    svgCoord(PAD_X + (i / Math.max(1, lastIndex)) * innerW);
  const sy = (v: number) =>
    svgCoord(PAD_Y + innerH - ((v - minY) / yRange) * innerH);

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${sx(i)} ${sy(p.balancePaise)}`)
    .join(" ");

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((t) => minY + t * yRange);
  const ticks = [0, Math.floor(points.length / 2), lastIndex];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-60 w-full text-neutral-500"
      preserveAspectRatio="none"
    >
      {gridYs.map((v, gi) => (
        <line
          key={gi}
          x1={PAD_X}
          x2={W - PAD_X}
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
          x={PAD_X - 6}
          y={sy(v)}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={9}
          fill="currentColor"
          opacity={0.7}
        >
          {formatPaisePlain(Math.round(v))}
        </text>
      ))}
      {ticks.map((i) => (
        <text
          key={points[i].date}
          x={sx(i)}
          y={H - 4}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor"
          opacity={0.7}
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
      ? "text-red-700 dark:text-red-400"
      : tone === "credit"
        ? "text-emerald-700 dark:text-emerald-400"
        : "";
  return (
    <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs uppercase text-neutral-500">{label}</div>
      <div className={`mt-1 font-mono text-base ${toneClass}`}>{value}</div>
    </div>
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
          href="/timeline"
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
            href={`/timeline?preset=${p.key}`}
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
