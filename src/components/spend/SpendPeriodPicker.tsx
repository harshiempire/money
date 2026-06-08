import Link from "next/link";
import { PRESET_PERIODS } from "@/lib/period";
import {
  adjacentMonthHref,
  spendPeriodHref,
  type ResolvedSpendPeriod,
  type SpendSearchParams,
} from "@/lib/spend/period";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";

export function SpendPeriodPicker({
  resolved,
  sp,
  basePath = "/spend",
  statementPeriods = [],
}: {
  resolved: ResolvedSpendPeriod;
  sp: SpendSearchParams;
  basePath?: string;
  statementPeriods?: Array<{ periodStart: string; periodEnd: string }>;
}) {
  const { period, mode, monthKey, isPartial } = resolved;
  const prevHref =
    monthKey && mode === "month" ? adjacentMonthHref(monthKey, -1, basePath) : null;
  const nextHref =
    monthKey && mode === "month" ? adjacentMonthHref(monthKey, 1, basePath) : null;

  const href = (params: SpendSearchParams) =>
    spendPeriodHref(params, basePath);

  const isThisMonth =
    mode === "month" &&
    !sp.month &&
    !sp.preset &&
    !sp.statement &&
    !sp.from;

  const isCustomRange =
    mode === "custom" && Boolean(sp.from || sp.to);

  const presetKeys = Object.keys(PRESET_PERIODS);

  return (
    <div className="space-y-4">
      {mode === "month" && monthKey && (
        <div className="flex items-center justify-center gap-4">
          {prevHref ? (
            <Link href={prevHref}>
              <Button variant="outline" size="sm">←</Button>
            </Link>
          ) : (
            <span className="w-10" />
          )}
          <div className="text-center">
            <div className="font-semibold text-[var(--color-text)]">{period.label}</div>
            {isPartial && (
              <div className="text-xs text-[var(--color-text-muted)]">Month in progress</div>
            )}
          </div>
          {nextHref ? (
            <Link href={nextHref}>
              <Button variant="outline" size="sm">→</Button>
            </Link>
          ) : (
            <span className="w-10" />
          )}
        </div>
      )}

      {mode !== "month" && (
        <div className="text-center font-mono text-sm text-[var(--color-text-secondary)]">
          {period.label}
          {isPartial && (
            <span className="ml-2 text-xs text-[var(--color-text-muted)]">(in progress)</span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {presetKeys.map((key) => (
          <PeriodChip
            key={key}
            href={href({ preset: key })}
            active={sp.preset === key || (key === "this_month" && isThisMonth)}
            label={PRESET_PERIODS[key]().label}
          />
        ))}
        <PeriodChip
          href={href({ statement: "1" })}
          active={mode === "statement"}
          label="Statement"
        />
      </div>

      <form
        method="get"
        action={basePath}
        className={cn(
          "mx-auto flex max-w-md flex-wrap items-end justify-center gap-3 rounded-[var(--radius-lg)] border p-4 text-sm",
          isCustomRange
            ? "border-[var(--color-accent)] bg-[var(--color-accent-muted)]/20"
            : "border-[var(--color-border)] bg-[var(--color-surface-raised)]",
        )}
      >
        <label className="flex flex-col">
          <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">From</span>
          <input
            type="date"
            name="from"
            defaultValue={period.from ?? sp.from ?? ""}
            className="mt-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs focus-ring"
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">To</span>
          <input
            type="date"
            name="to"
            defaultValue={period.to ?? sp.to ?? ""}
            className="mt-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs focus-ring"
          />
        </label>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm">Apply</Button>
          {isCustomRange && (
            <Link
              href={href({})}
              className="text-xs text-[var(--color-text-secondary)] underline-offset-2 hover:underline"
            >
              Clear
            </Link>
          )}
        </div>
      </form>

      {statementPeriods.length > 1 && (
        <details className="text-xs text-[var(--color-text-muted)]">
          <summary className="cursor-pointer text-center font-medium hover:text-[var(--color-text)]">
            Past statement periods
          </summary>
          <ul className="mt-2 space-y-1 text-center">
            {statementPeriods.map((s) => {
              const active =
                period.from === s.periodStart && period.to === s.periodEnd;
              return (
                <li key={`${s.periodStart}-${s.periodEnd}`}>
                  <Link
                    href={href({
                      from: s.periodStart,
                      to: s.periodEnd,
                    })}
                    className={cn(
                      active
                        ? "font-semibold text-[var(--color-accent)]"
                        : "text-[var(--color-text-secondary)] underline underline-offset-2 hover:text-[var(--color-text)]",
                    )}
                  >
                    {s.periodStart} → {s.periodEnd}
                  </Link>
                </li>
              );
            })}
          </ul>
        </details>
      )}
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
