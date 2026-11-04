import {
  MAX_MONTH_YEAR,
  MIN_MONTH_YEAR,
  clampMonthYear,
  formatMonthKey,
  indiaCivilDate,
  indiaMonthKey,
  isSupportedMonthYear,
  parseMonthKey,
} from "@/lib/dates/india";
import { spendPeriodHref } from "@/lib/spend/period-href";

export {
  MAX_MONTH_YEAR,
  MIN_MONTH_YEAR,
  formatMonthKey,
  isSupportedMonthYear,
  parseMonthKey,
};

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

export function currentMonthKey(now = new Date()): string {
  return indiaMonthKey(now);
}

/** Year the picker should open on. Selected month wins, then an anchor date. */
export function initialPickerYear(
  selectedMonthKey: string | undefined,
  anchorMonthKey: string | undefined,
  now = new Date(),
): number {
  return clampMonthYear(
    parseMonthKey(selectedMonthKey ?? "")?.year ??
      parseMonthKey(anchorMonthKey ?? "")?.year ??
      indiaCivilDate(now).year,
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
  if (!isSupportedMonthYear(year)) return [];
  return MONTH_SHORT.flatMap((shortLabel, index) => {
    const month = index + 1;
    const monthKey = formatMonthKey(year, month);
    if (!monthKey) return [];
    return [
      {
        month,
        monthKey,
        shortLabel,
        longLabel: `${MONTH_LONG[index]} ${year}`,
        href: spendPeriodHref({ month: monthKey }, basePath),
      },
    ];
  });
}
