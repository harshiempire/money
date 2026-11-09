import Link from "next/link";
import { MonthJump } from "@/components/spend/MonthJump";
import { PRESET_PERIODS } from "@/lib/period";
import { currentMonthKey } from "@/lib/spend/month-jump";
import {
  adjacentMonthHref,
  spendPeriodHref,
  type SpendSearchParams,
} from "@/lib/spend/period-href";
import type { ResolvedSpendPeriod } from "@/lib/spend/period";

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
  const todayMonthKey = currentMonthKey();
  const anchorMonthKey =
    monthKey ??
    (period.from && /^\d{4}-\d{2}/.test(period.from)
      ? period.from.slice(0, 7)
      : undefined);
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
    <div className="mt-6 space-y-3">
      {mode === "month" && monthKey && (
        <div className="flex items-center justify-center gap-4">
          {prevHref ? (
            <Link
              href={prevHref}
              className="rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
            >
              ←
            </Link>
          ) : (
            <span className="w-10" />
          )}
          <div className="text-center">
            <MonthJump
              variant="label"
              label={period.label}
              selectedMonthKey={monthKey}
              anchorMonthKey={anchorMonthKey}
              todayMonthKey={todayMonthKey}
              basePath={basePath}
            />
            {isPartial && (
              <div className="text-xs text-neutral-500">Month in progress</div>
            )}
          </div>
          {nextHref ? (
            <Link
              href={nextHref}
              className="rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
            >
              →
            </Link>
          ) : (
            <span className="w-10" />
          )}
        </div>
      )}

      {mode !== "month" && (
        <div className="text-center font-mono text-sm text-neutral-700 dark:text-neutral-300">
          {period.label}
          {isPartial && (
            <span className="ml-2 text-xs text-neutral-500">(in progress)</span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs">
        {presetKeys.map((key) => (
          <Link
            key={key}
            href={href({ preset: key })}
            className={`rounded border px-2 py-1 ${
              sp.preset === key ||
              (key === "this_month" && isThisMonth)
                ? "border-neutral-900 dark:border-neutral-100"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            {PRESET_PERIODS[key]().label}
          </Link>
        ))}
        <Link
          href={href({ statement: "1" })}
          className={`rounded border px-2 py-1 ${
            mode === "statement"
              ? "border-neutral-900 dark:border-neutral-100"
              : "border-neutral-300 dark:border-neutral-700"
          }`}
        >
          Statement
        </Link>
        {mode !== "month" && (
          <MonthJump
            variant="chip"
            label="Jump to month"
            anchorMonthKey={anchorMonthKey}
            todayMonthKey={todayMonthKey}
            basePath={basePath}
          />
        )}
      </div>

      {/* key: <Link> navigation keeps this form mounted, and inputs only read
          defaultValue on mount, so remount it when the period changes. */}
      <form
        key={`${period.from ?? sp.from ?? ""}|${period.to ?? sp.to ?? ""}`}
        method="get"
        action={basePath}
        className={`mx-auto flex max-w-md flex-wrap items-end justify-center gap-3 rounded border p-3 text-sm ${
          isCustomRange
            ? "border-neutral-900 dark:border-neutral-100"
            : "border-neutral-200 dark:border-neutral-800"
        }`}
      >
        <label className="flex flex-col">
          <span className="text-xs uppercase text-neutral-500">From</span>
          <input
            type="date"
            name="from"
            defaultValue={period.from ?? sp.from ?? ""}
            className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 text-xs dark:border-neutral-700"
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs uppercase text-neutral-500">To</span>
          <input
            type="date"
            name="to"
            defaultValue={period.to ?? sp.to ?? ""}
            className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 text-xs dark:border-neutral-700"
          />
        </label>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            Apply
          </button>
          {isCustomRange && (
            <Link
              href={href({})}
              className="text-xs text-neutral-600 underline-offset-2 hover:underline dark:text-neutral-400"
            >
              Clear
            </Link>
          )}
        </div>
      </form>

      {statementPeriods.length > 1 && (
        <details className="text-xs text-neutral-500">
          <summary className="cursor-pointer text-center">
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
                    className={active ? "font-medium text-neutral-900 dark:text-neutral-100" : "underline"}
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
