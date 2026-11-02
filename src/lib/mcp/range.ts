import type { PeriodInput } from "./schemas";

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** MCP calendar months always include the full month, including future-dated rows. */
export function resolveMcpPeriod(input: PeriodInput) {
  if (input.month) {
    const [year, month] = input.month.split("-").map(Number);
    return {
      from: `${input.month}-01`,
      to: `${input.month}-${daysInMonth(year, month)}`,
      label: input.month,
      partial: false,
    };
  }
  return {
    from: input.from ?? null,
    to: input.to ?? null,
    label: input.from || input.to ? `${input.from ?? "…"} → ${input.to ?? "…"}` : "All time",
    partial: false,
  };
}
