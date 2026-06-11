import { formatPaise } from "@/lib/format";

/**
 * "+₹X vs previous (label)" delta line, coloured spend/inflow by direction.
 * Shared by the dashboard and the spend report.
 */
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
    <span className={up ? "text-spend" : "text-inflow"}>
      {up ? "+" : "−"}
      {formatPaise(Math.abs(delta))} vs previous
      {previousLabel ? ` (${previousLabel})` : " period"}
    </span>
  );
}
