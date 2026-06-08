import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { backfillCounterparties } from "@/db/counterparty-backfill";
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
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { Money } from "@/components/ui/Money";
import { PeriodDelta } from "@/components/ui/PeriodDelta";
import { Button } from "@/components/ui/Button";
import { IconChevronRight } from "@/components/icons";
import { cn } from "@/lib/cn";

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

  const [totals, bridge, reimbursement, triage, cats, tops, prevComparison] =
    await Promise.all([
      netSpendTotals(account.id, period.from, period.to),
      splitBridgeTotals(account.id, period.from, period.to),
      reimbursementBridgeTotals(account.id, period.from, period.to),
      triageStats(account.id, period.from, period.to),
      categoryBreakdown(account.id, period.from, period.to),
      topCounterparties(account.id, period.from, period.to, 8),
      loadPreviousPeriodComparison(account.id, period, isStatementMode),
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

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Your true spending after splits, transfers, and reimbursements"
      />

      <PeriodPicker period={period} active={sp.preset} spendLink={spendLink} />

      {/* Hero metric */}
      <Card className="mt-6 overflow-hidden" padding="none">
        <div className="bg-gradient-to-br from-[var(--color-accent-muted)] to-transparent p-6 sm:p-8">
          <div className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-secondary)]">
            Net personal spend · {period.label}
          </div>
          <div className="mt-2">
            <Money
              paise={totals.netSelfPaise}
              signed
              size="hero"
            />
            {totals.netSelfPaise < 0 && (
              <span className="ml-3 text-sm font-medium text-[var(--color-credit)]">
                net inflow
              </span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
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
          </div>
        </div>
      </Card>

      {/* Quick actions */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <QuickAction
          href="/transactions"
          title="Categorize"
          description="Tag uncategorized transactions"
          count={triage.uncategorizedCount > 0 ? triage.uncategorizedCount : undefined}
        />
        <QuickAction
          href="/import"
          title="Import"
          description="Upload a new statement"
        />
        <QuickAction
          href={spendLink}
          title="Spend report"
          description="Deep dive into your spending"
        />
      </div>

      {showTriage && (
        <Alert variant="warning" title="Needs attention" className="mt-6">
          <ul className="space-y-1">
            {triage.uncategorizedCount > 0 && (
              <li>
                <Link href="/transactions" className="font-medium underline underline-offset-2">
                  {triage.uncategorizedCount} uncategorized
                </Link>
                {triage.uncategorizedNetSelfPaise !== 0 && (
                  <span className="font-mono text-xs">
                    {" "}· {formatPaise(Math.abs(triage.uncategorizedNetSelfPaise))} net
                  </span>
                )}
              </li>
            )}
            {triage.needsReviewCount > 0 && (
              <li>
                <Link href="/review" className="font-medium underline underline-offset-2">
                  {triage.needsReviewCount} flagged for review
                </Link>
              </li>
            )}
          </ul>
        </Alert>
      )}

      {showBreakdown && (
        <Card className="mt-6">
          <CardHeader
            title="Spend breakdown"
            description="How gross debits become net personal spend"
            action={
              <Link href={spendLink}>
                <Button variant="ghost" size="sm">
                  Full report <IconChevronRight />
                </Button>
              </Link>
            }
          />
          <div className="mt-4">
            <SpendBreakdown
              bridge={bridge}
              netSelfPaise={totals.netSelfPaise}
              reimbursement={reimbursement}
              compact
            />
          </div>
        </Card>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="By category"
            description={
              totalSpendPaise > 0
                ? "% of net personal spend in this period"
                : undefined
            }
          />
          {spendCats.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--color-text-muted)]">
              Nothing categorized yet — head to{" "}
              <Link href="/transactions" className="font-medium text-[var(--color-accent)] underline underline-offset-2">
                Transactions
              </Link>{" "}
              to tag rows.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {spendCats.map((c) => (
                <li key={c.categoryName}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium">{c.categoryName}</span>
                    <span className="font-mono text-xs whitespace-nowrap text-[var(--color-text-secondary)]">
                      {formatPaise(c.netSelfPaise)}
                      {totalSpendPaise > 0 && (
                        <span className="text-[var(--color-text-muted)]">
                          {" "}· {((c.netSelfPaise / totalSpendPaise) * 100).toFixed(0)}%
                        </span>
                      )}
                      <span className="text-[var(--color-text-muted)]"> · {c.count}</span>
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--color-surface-overlay)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-debit)]/70 transition-all"
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
            <div className="mt-6 border-t border-[var(--color-border)] pt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-credit)]">
                Inflows reducing net
              </h3>
              <ul className="mt-2 space-y-1 text-sm">
                {refundCats.map((c) => (
                  <li key={c.categoryName} className="flex items-baseline justify-between">
                    <span>{c.categoryName}</span>
                    <span className="font-mono text-xs text-[var(--color-credit)]">
                      −{formatPaise(Math.abs(c.netSelfPaise))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Top counterparties" />
          {tops.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--color-text-muted)]">
              No counterparty spend in this period.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-[var(--color-border)]">
              {tops.map((t, i) => (
                <li
                  key={t.counterpartyId}
                  className="flex items-center gap-3 py-2.5 text-sm first:pt-0 last:pb-0"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-overlay)] text-xs font-medium text-[var(--color-text-muted)]">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{t.displayName}</span>
                  <span className="font-mono text-xs whitespace-nowrap text-[var(--color-text-secondary)]">
                    {formatPaise(t.netSelfPaise)}
                    <span className="text-[var(--color-text-muted)]"> · {t.count}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function QuickAction({
  href,
  title,
  description,
  count,
}: {
  href: string;
  title: string;
  description: string;
  count?: number;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4 transition-colors hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-accent-muted)]/30"
    >
      <div>
        <div className="flex items-center gap-2 text-sm font-medium">
          {title}
          {count != null && count > 0 && (
            <span className="rounded-full bg-[var(--color-warning-muted)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-warning)]">
              {count}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{description}</p>
      </div>
      <IconChevronRight className="text-[var(--color-text-muted)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--color-accent)]" />
    </Link>
  );
}

function PeriodPicker({
  period,
  active,
  spendLink,
}: {
  period: { label: string };
  active?: string;
  spendLink: string;
}) {
  const presets = Object.entries(PRESET_PERIODS).map(([key, fn]) => ({
    key,
    ...fn(),
  }));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        Period
      </span>
      <span className="font-mono text-xs text-[var(--color-text-secondary)]">
        {period.label}
      </span>
      <div className="ml-auto flex flex-wrap gap-1.5">
        <PeriodChip href="/" active={!active} label="Statement" />
        {presets.map((p) => (
          <PeriodChip
            key={p.key}
            href={`/?preset=${p.key}`}
            active={active === p.key}
            label={p.label}
          />
        ))}
        <PeriodChip href={spendLink} active={false} label="Full report" />
      </div>
    </div>
  );
}

function PeriodChip({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-full px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-[var(--color-accent)] text-white"
          : "bg-[var(--color-surface-overlay)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)]",
      )}
    >
      {label}
    </Link>
  );
}

async function loadPreviousPeriodComparison(
  accountId: string,
  period: { from: string | null; to: string | null },
  isStatementMode: boolean,
) {
  if (!period.from || !period.to) return null;

  let prevFrom = period.from;
  let prevTo = period.to;
  let label = `${prevFrom} → ${prevTo}`;

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

  const totals = await netSpendTotals(accountId, prevFrom, prevTo);
  return { totals, label };
}
