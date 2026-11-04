import { shiftCalendarMonth } from "@/lib/period";

export interface SpendSearchParams {
  month?: string;
  from?: string;
  to?: string;
  preset?: string;
  statement?: string;
}

export function spendPeriodHref(
  sp: SpendSearchParams,
  base = "/spend",
): string {
  const q = new URLSearchParams();
  if (sp.month) q.set("month", sp.month);
  if (sp.preset) q.set("preset", sp.preset);
  if (sp.statement) q.set("statement", sp.statement);
  if (sp.from) q.set("from", sp.from);
  if (sp.to) q.set("to", sp.to);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

export function reimbursementsPeriodHref(sp: SpendSearchParams): string {
  return spendPeriodHref(sp, "/reimbursements");
}

export function adjacentMonthHref(
  monthKey: string,
  delta: -1 | 1,
  basePath = "/spend",
): string | null {
  const next = shiftCalendarMonth(monthKey, delta);
  if (!next) return null;
  return spendPeriodHref({ month: next }, basePath);
}
