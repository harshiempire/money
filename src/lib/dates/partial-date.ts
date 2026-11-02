/**
 * Dates as people say them — "26 Aug", "August 26", "26/08/2026" — read into
 * whichever parts were actually stated. A part the user didn't say stays
 * null; filling it in is the caller's job, against real transaction data,
 * so the UI can say "you didn't give a year; found in 2025".
 *
 * Numeric dates are read day-first (Indian convention). Anything ambiguous
 * returns null so the caller asks rather than guesses.
 */

export interface PartialDate {
  year: number | null;
  month: number | null;
  day: number | null;
}

export interface DateWindow {
  /** Inclusive ISO bounds. */
  from: string;
  to: string;
  /** The exact day asked about, when a day was stated. */
  target: string | null;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");
export const toIso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

// 2000 is a leap year, so Feb 29 passes when no year was stated.
const validDay = (day: number, month: number, year: number | null) =>
  day >= 1 && day <= daysInMonth(year ?? 2000, month);

const readYear = (s: string | undefined): number | null | undefined => {
  if (s === undefined) return null;
  const n = Number(s);
  if (s.length === 2) return 2000 + n;
  if (s.length === 4 && n >= 1990 && n <= 2100) return n;
  return undefined; // present but unreadable
};

function build(
  day: number | null,
  month: number | null,
  year: number | null | undefined,
): PartialDate | null {
  if (year === undefined) return null;
  if (month !== null && (month < 1 || month > 12)) return null;
  if (day !== null && (month === null || !validDay(day, month, year))) return null;
  if (day === null && month === null && year === null) return null;
  return { year, month, day };
}

export function parsePartialDate(text: string, today: string): PartialDate | null {
  const s = text
    .trim()
    .toLowerCase()
    .replace(/(\d)(st|nd|rd|th)\b/g, "$1")
    .replace(/\bof\b/g, " ")
    .replace(/[,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;

  if (s === "today" || s === "yesterday") {
    const d = new Date(`${today}T00:00:00Z`);
    if (s === "yesterday") d.setUTCDate(d.getUTCDate() - 1);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }

  // 2026-08-26
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return build(Number(m[3]), Number(m[2]), readYear(m[1]));

  // 26/08, 26-8-2026, 26/8/26
  m = s.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/);
  if (m) return build(Number(m[1]), Number(m[2]), readYear(m[3]));

  // 26 aug [2026]
  m = s.match(/^(\d{1,2}) ([a-z]+)(?: (\d{2}|\d{4}))?$/);
  if (m && MONTHS[m[2]]) return build(Number(m[1]), MONTHS[m[2]], readYear(m[3]));

  // aug 26 [2026]
  m = s.match(/^([a-z]+) (\d{1,2})(?: (\d{4}))?$/);
  if (m && MONTHS[m[1]]) return build(Number(m[2]), MONTHS[m[1]], readYear(m[3]));

  // aug [2026]
  m = s.match(/^([a-z]+)(?: (\d{4}))?$/);
  if (m && MONTHS[m[1]]) return build(null, MONTHS[m[1]], readYear(m[2]));

  // 2026
  m = s.match(/^(\d{4})$/);
  if (m) return build(null, null, readYear(m[1]));

  return null;
}

const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Turns stated parts into concrete search windows. A missing year expands to
 * every year the account has data for; a stated day gets ±`slackDays` so
 * "around the 26th" still finds a value-dated 27th.
 */
export function dateWindows(
  date: PartialDate,
  yearsWithData: number[],
  slackDays = 3,
): DateWindow[] {
  const years = date.year !== null ? [date.year] : yearsWithData;
  const windows: DateWindow[] = [];
  for (const year of years) {
    if (date.month === null) {
      windows.push({ from: toIso(year, 1, 1), to: toIso(year, 12, 31), target: null });
    } else if (date.day === null) {
      windows.push({
        from: toIso(year, date.month, 1),
        to: toIso(year, date.month, daysInMonth(year, date.month)),
        target: null,
      });
    } else if (validDay(date.day, date.month, year)) {
      const target = toIso(year, date.month, date.day);
      windows.push({ from: shift(target, -slackDays), to: shift(target, slackDays), target });
    }
  }
  return windows;
}

/** Whole days from a to b (b later → positive). */
export const daysBetween = (a: string, b: string) =>
  Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );

const MONTH_WORD =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const DATE_SPANS = [
  /\b\d{4}-\d{1,2}-\d{1,2}\b/gi,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-](?:\d{4}|\d{2}))?\b/gi,
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?(?:\\s+of)?\\s+(?:${MONTH_WORD})\\b`, "gi"),
  new RegExp(`\\b(?:${MONTH_WORD})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"),
  // A bare year — unless it's written as money ("₹2026", "rs 2026").
  /(?<!(?:₹|rs\.?|inr)\s*)\b(?:19|20)\d{2}\b/gi,
];

/** The text with date-like spans blanked out, so their digits aren't read as amounts. */
export function stripDateSpans(text: string): string {
  return DATE_SPANS.reduce((t, re) => t.replace(re, " "), text);
}
