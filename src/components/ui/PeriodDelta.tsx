import { formatPaise } from "@/lib/format";
import { cn } from "@/lib/cn";

export function PeriodDelta({
  delta,
  previousLabel,
}: {
  delta: number;
  previousLabel?: string;
}) {
  if (delta === 0) {
    return (
      <span className="text-[var(--color-text-muted)]">
        Same as previous period
        {previousLabel ? ` (${previousLabel})` : ""}
      </span>
    );
  }
  const up = delta > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-medium",
        up ? "text-[var(--color-debit)]" : "text-[var(--color-credit)]",
      )}
    >
      <span aria-hidden>{up ? "↑" : "↓"}</span>
      {formatPaise(Math.abs(delta))} vs previous
      {previousLabel ? ` (${previousLabel})` : " period"}
    </span>
  );
}
