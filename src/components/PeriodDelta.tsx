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
      <span>
        Same as previous period
        {previousLabel ? ` (${previousLabel})` : ""}
      </span>
    );
  }
  const up = delta > 0;
  return (
    <span className={cn(up ? "text-debit" : "text-credit")}>
      {up ? "+" : "−"}
      {formatPaise(Math.abs(delta))} vs previous
      {previousLabel ? ` (${previousLabel})` : " period"}
    </span>
  );
}
