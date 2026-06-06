import { cn } from "@/lib/cn";
import { Card } from "./Card";

type MetricTone = "debit" | "credit" | "neutral";

export function MetricHero({
  label,
  value,
  suffix,
  meta,
  tone = "neutral",
}: {
  label: string;
  value: string;
  suffix?: string;
  meta?: React.ReactNode;
  tone?: MetricTone;
}) {
  const valueTone =
    tone === "debit"
      ? "text-debit"
      : tone === "credit"
        ? "text-credit"
        : "text-neutral-900 dark:text-neutral-50";

  return (
    <Card className="mt-6">
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className={cn("mt-2 font-mono text-4xl md:text-5xl", valueTone)}>
        {value}
        {suffix && (
          <span className="ml-2 text-base font-sans font-normal text-credit">
            {suffix}
          </span>
        )}
      </div>
      {meta && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
          {meta}
        </div>
      )}
    </Card>
  );
}
