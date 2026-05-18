import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { backfillCounterparties } from "@/db/counterparty-backfill";
import { AppNav } from "@/components/AppNav";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import {
  categoryBreakdown,
  netSpendTotals,
  topCounterparties,
} from "@/domain/spend/net";
import { resolvePeriod, PRESET_PERIODS } from "@/lib/period";
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

  // Default to the latest imported statement period when no params given.
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

  const totals = await netSpendTotals(account.id, period.from, period.to);
  const cats = await categoryBreakdown(account.id, period.from, period.to);
  const tops = await topCounterparties(account.id, period.from, period.to, 8);

  // Split categories into "spend" (positive net) and "negative" (refunds/income)
  // for clearer presentation; cats is already pre-sorted.
  const spendCats = cats.filter((c) => c.netSelfPaise > 0);
  const refundCats = cats.filter((c) => c.netSelfPaise < 0);

  const maxSpend = spendCats[0]?.netSelfPaise ?? 1;

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
        <p className="mt-1 text-xs text-neutral-500">
          Across {totals.count} transaction{totals.count === 1 ? "" : "s"} ·
          gross debits {formatPaise(totals.totalDebitPaise)} · gross credits{" "}
          {formatPaise(totals.totalCreditPaise)}
        </p>
      </section>

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
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium">{c.categoryName}</span>
                    <span className="font-mono text-xs">
                      {formatPaise(c.netSelfPaise)}{" "}
                      <span className="text-neutral-500">· {c.count}</span>
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
