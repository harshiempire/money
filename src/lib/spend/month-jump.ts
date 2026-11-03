import { spendPeriodHref } from "@/lib/spend/period-href";

const MONTH_RE = /^(\d{4})-(\d{2})$/;

export const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function parseMonthKey(
  monthKey: string,
): { year: number; month: number } | null {
  const match = MONTH_RE.exec(monthKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

export function formatMonthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function currentMonthKey(now = new Date()): string {
  return formatMonthKey(now.getFullYear(), now.getMonth() + 1);
}

/** Year the picker should open on. Selected month wins, then an anchor date. */
export function initialPickerYear(
  selectedMonthKey: string | undefined,
  anchorMonthKey: string | undefined,
  now = new Date(),
): number {
  return (
    parseMonthKey(selectedMonthKey ?? "")?.year ??
    parseMonthKey(anchorMonthKey ?? "")?.year ??
    now.getFullYear()
  );
}

export interface MonthJumpOption {
  month: number;
  monthKey: string;
  shortLabel: string;
  longLabel: string;
  href: string;
}

/** Twelve calendar months for one year. Each href is a full-month report, same as the arrows. */
export function monthJumpOptions(
  year: number,
  basePath = "/spend",
): MonthJumpOption[] {
  return MONTH_SHORT.map((shortLabel, index) => {
    const month = index + 1;
    const monthKey = formatMonthKey(year, month);
    return {
      month,
      monthKey,
      shortLabel,
      longLabel: `${MONTH_LONG[index]} ${year}`,
      href: spendPeriodHref({ month: monthKey }, basePath),
    };
  });
}
