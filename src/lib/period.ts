import {
  addCivilDays,
  daysInMonth,
  formatIsoDate,
  formatMonthKey,
  indiaCivilDate,
  parseMonthKey,
} from "@/lib/dates/india";

export interface Period {
  from: string | null;
  to: string | null;
  label: string;
}

const MONTH_NAMES = [
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

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export interface CalendarMonthPeriod extends Period {
  monthKey: string;
  isPartial: boolean;
}

export function calendarMonthPeriod(
  year: number,
  month: number,
  now: Date = new Date(),
): CalendarMonthPeriod {
  const today = indiaCivilDate(now);
  const isCurrentMonth = today.year === year && today.month === month;
  const monthKey =
    formatMonthKey(year, month) ??
    `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  const from = `${monthKey}-01`;
  const to = isCurrentMonth
    ? formatIsoDate(today)
    : `${monthKey}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
  const monthLabel = `${MONTH_NAMES[month - 1] ?? "Month"} ${year}`;
  return {
    from,
    to,
    label: isCurrentMonth ? `${monthLabel} (in progress)` : monthLabel,
    monthKey,
    isPartial: isCurrentMonth,
  };
}

export function shiftCalendarMonth(monthKey: string, delta: number): string | null {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) return null;
  const utc = new Date(Date.UTC(parsed.year, parsed.month - 1 + delta, 1));
  return formatMonthKey(utc.getUTCFullYear(), utc.getUTCMonth() + 1);
}

export function thisMonthPeriod(now: Date = new Date()): {
  from: string;
  to: string;
  label: string;
} {
  const today = indiaCivilDate(now);
  return {
    from: formatIsoDate({ ...today, day: 1 }),
    to: formatIsoDate(today),
    label: "This month",
  };
}

export function trailingDaysPeriod(
  days: number,
  label: string,
  now: Date = new Date(),
): { from: string; to: string; label: string } {
  const today = indiaCivilDate(now);
  return {
    from: formatIsoDate(addCivilDays(today, -days)),
    to: formatIsoDate(today),
    label,
  };
}

export const PRESET_PERIODS: Record<
  string,
  (now?: Date) => { from: string; to: string; label: string }
> = {
  this_month: (now) => thisMonthPeriod(now),
  last_30: (now) => trailingDaysPeriod(30, "Last 30 days", now),
  last_90: (now) => trailingDaysPeriod(90, "Last 90 days", now),
};

export function resolvePeriod(sp: {
  from?: string;
  to?: string;
  preset?: string;
}): Period {
  if (sp.preset && PRESET_PERIODS[sp.preset]) {
    return PRESET_PERIODS[sp.preset]();
  }
  if (sp.from || sp.to) {
    return {
      from: sp.from ?? null,
      to: sp.to ?? null,
      label: `${sp.from ?? "…"} → ${sp.to ?? "…"}`,
    };
  }
  return { from: null, to: null, label: "All time" };
}

const parseIso = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export function inclusiveDayCount(from: string, to: string): number {
  const ms = parseIso(to).getTime() - parseIso(from).getTime();
  return Math.max(1, Math.floor(ms / 86_400_000) + 1);
}

export function previousPeriodWindow(
  from: string,
  to: string,
): { from: string; to: string; label: string } {
  const days = inclusiveDayCount(from, to);
  const prevTo = parseIso(from);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - (days - 1));
  const f = iso(prevFrom);
  const t = iso(prevTo);
  return { from: f, to: t, label: `${f} → ${t}` };
}
