import { PRESET_PERIODS } from "@/lib/period";
import {
  adjacentMonthHref,
  spendPeriodHref,
  type ResolvedSpendPeriod,
  type SpendSearchParams,
} from "@/lib/spend/period";

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

  return (
    <div className="mt-6 space-y-3">
      {mode === "month" && monthKey && (
        <div className="flex items-center justify-center gap-4">
          {prevHref ? (
            <a
              href={prevHref}
              className="rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
            >
              ←
            </a>
          ) : (
            <span className="w-10" />
          )}
          <div className="text-center">
            <div className="font-medium">{period.label}</div>
            {isPartial && (
              <div className="text-xs text-neutral-500">Month in progress</div>
            )}
          </div>
          {nextHref ? (
            <a
              href={nextHref}
              className="rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
            >
              →
            </a>
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
        <a
          href={href({})}
          className={`rounded border px-2 py-1 ${
            isThisMonth
              ? "border-neutral-900 dark:border-neutral-100"
              : "border-neutral-300 dark:border-neutral-700"
          }`}
        >
          This month
        </a>
        {Object.keys(PRESET_PERIODS).map((key) => (
          <a
            key={key}
            href={href({ preset: key })}
            className={`rounded border px-2 py-1 ${
              sp.preset === key
                ? "border-neutral-900 dark:border-neutral-100"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            {PRESET_PERIODS[key]().label}
          </a>
        ))}
        <a
          href={href({ statement: "1" })}
          className={`rounded border px-2 py-1 ${
            mode === "statement"
              ? "border-neutral-900 dark:border-neutral-100"
              : "border-neutral-300 dark:border-neutral-700"
          }`}
        >
          Statement
        </a>
      </div>

      {statementPeriods.length > 1 && (
        <details className="text-xs text-neutral-500">
          <summary className="cursor-pointer text-center">
            Past statement periods
          </summary>
          <ul className="mt-2 space-y-1 text-center">
            {statementPeriods.map((s) => {
              const active =
                mode === "statement" &&
                period.from === s.periodStart &&
                period.to === s.periodEnd;
              return (
                <li key={`${s.periodStart}-${s.periodEnd}`}>
                  <a
                    href={href({
                      from: s.periodStart,
                      to: s.periodEnd,
                    })}
                    className={active ? "font-medium text-neutral-900 dark:text-neutral-100" : "underline"}
                  >
                    {s.periodStart} → {s.periodEnd}
                  </a>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
