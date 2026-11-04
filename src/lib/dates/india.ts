/**
 * Civil dates for the spend calendar. Always Asia/Kolkata, so a UTC server
 * and the month picker agree on which month is current — including the
 * first 5.5 hours of an IST day, which are still the previous UTC date.
 */

export const INDIA_TIME_ZONE = "Asia/Kolkata";

/** Inclusive years the month links and year controls will produce. */
export const MIN_MONTH_YEAR = 2000;
export const MAX_MONTH_YEAR = 2100;

export interface IndiaCivilDate {
  year: number;
  month: number;
  day: number;
}

export function indiaCivilDate(now: Date = new Date()): IndiaCivilDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = read("year");
  const month = read("month");
  const day = read("day");
  if (!year || !month || !day) {
    throw new Error("Could not read an Asia/Kolkata date");
  }
  return { year, month, day };
}

export function formatIsoDate(date: IndiaCivilDate): string {
  return `${padYear(date.year)}-${pad2(date.month)}-${pad2(date.day)}`;
}

export function indiaTodayIso(now: Date = new Date()): string {
  return formatIsoDate(indiaCivilDate(now));
}

export function indiaMonthKey(now: Date = new Date()): string {
  const date = indiaCivilDate(now);
  return `${padYear(date.year)}-${pad2(date.month)}`;
}

export function isSupportedMonthYear(year: number): boolean {
  return Number.isInteger(year) && year >= MIN_MONTH_YEAR && year <= MAX_MONTH_YEAR;
}

export function clampMonthYear(year: number): number {
  if (!Number.isInteger(year)) return MIN_MONTH_YEAR;
  return Math.min(MAX_MONTH_YEAR, Math.max(MIN_MONTH_YEAR, year));
}

/** Canonical YYYY-MM, or null when the year or month is outside the supported range. */
export function formatMonthKey(year: number, month: number): string | null {
  if (!isSupportedMonthYear(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  return `${padYear(year)}-${pad2(month)}`;
}

export function parseMonthKey(
  monthKey: string,
): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (formatMonthKey(year, month) !== monthKey) return null;
  return { year, month };
}

/** Calendar-day arithmetic that does not depend on the host timezone. */
export function addCivilDays(date: IndiaCivilDate, days: number): IndiaCivilDate {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

export function addCivilMonths(
  date: Pick<IndiaCivilDate, "year" | "month">,
  months: number,
): { year: number; month: number } {
  const utc = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1 };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad2 = (value: number) => String(value).padStart(2, "0");
const padYear = (value: number) => String(value).padStart(4, "0");
