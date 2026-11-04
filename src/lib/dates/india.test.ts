import { expect, test } from "bun:test";
import { calendarMonthPeriod, shiftCalendarMonth, thisMonthPeriod, trailingDaysPeriod } from "@/lib/period";
import { currentMonthKey, initialPickerYear } from "@/lib/spend/month-jump";
import {
  formatMonthKey,
  indiaMonthKey,
  indiaTodayIso,
  parseMonthKey,
} from "./india";

const YEAR_BOUNDARY = "2026-12-31T20:00:00.000Z";
const STILL_DECEMBER = "2026-12-31T18:29:59.000Z";
const JUST_JANUARY = "2026-12-31T18:30:00.000Z";
const STILL_JULY = "2026-07-31T18:29:59.000Z";
const JUST_AUGUST = "2026-07-31T18:30:00.000Z";

test("IST midnight, not UTC, decides the current month across month and year boundaries", () => {
  expect(indiaTodayIso(new Date(STILL_DECEMBER))).toBe("2026-12-31");
  expect(indiaMonthKey(new Date(STILL_DECEMBER))).toBe("2026-12");
  expect(currentMonthKey(new Date(STILL_DECEMBER))).toBe("2026-12");

  expect(indiaTodayIso(new Date(JUST_JANUARY))).toBe("2027-01-01");
  expect(indiaMonthKey(new Date(JUST_JANUARY))).toBe("2027-01");
  expect(currentMonthKey(new Date(JUST_JANUARY))).toBe("2027-01");

  // First 5.5 hours of 1 Jan IST are still 31 Dec UTC.
  expect(indiaTodayIso(new Date(YEAR_BOUNDARY))).toBe("2027-01-01");
  expect(indiaMonthKey(new Date(YEAR_BOUNDARY))).toBe("2027-01");
  expect(currentMonthKey(new Date(YEAR_BOUNDARY))).toBe("2027-01");
  expect(initialPickerYear(undefined, undefined, new Date(YEAR_BOUNDARY))).toBe(2027);

  expect(indiaTodayIso(new Date(STILL_JULY))).toBe("2026-07-31");
  expect(currentMonthKey(new Date(STILL_JULY))).toBe("2026-07");
  expect(indiaTodayIso(new Date(JUST_AUGUST))).toBe("2026-08-01");
  expect(currentMonthKey(new Date(JUST_AUGUST))).toBe("2026-08");
});

test("period resolution uses the same IST date as the picker", () => {
  const now = new Date(YEAR_BOUNDARY);
  const january = calendarMonthPeriod(2027, 1, now);
  expect(january.monthKey).toBe(currentMonthKey(now));
  expect(january.isPartial).toBe(true);
  expect(january.from).toBe("2027-01-01");
  expect(january.to).toBe("2027-01-01");
  expect(january.label).toBe("January 2027 (in progress)");

  const december = calendarMonthPeriod(2026, 12, now);
  expect(december.isPartial).toBe(false);
  expect(december.from).toBe("2026-12-01");
  expect(december.to).toBe("2026-12-31");
  expect(december.label).toBe("December 2026");

  const julyEnd = new Date(STILL_JULY);
  const july = calendarMonthPeriod(2026, 7, julyEnd);
  expect(july.isPartial).toBe(true);
  expect(july.to).toBe("2026-07-31");
  expect(july.monthKey).toBe(currentMonthKey(julyEnd));

  const augustStart = new Date(JUST_AUGUST);
  const august = calendarMonthPeriod(2026, 8, augustStart);
  expect(august.isPartial).toBe(true);
  expect(august.from).toBe("2026-08-01");
  expect(august.to).toBe("2026-08-01");
  expect(august.monthKey).toBe(currentMonthKey(augustStart));

  expect(thisMonthPeriod(now)).toEqual({
    from: "2027-01-01",
    to: "2027-01-01",
    label: "This month",
  });
  expect(trailingDaysPeriod(1, "Yesterday", now)).toEqual({
    from: "2026-12-31",
    to: "2027-01-01",
    label: "Yesterday",
  });
});

test("month keys stay canonical YYYY-MM inside the supported years", () => {
  expect(formatMonthKey(2026, 7)).toBe("2026-07");
  expect(formatMonthKey(2000, 1)).toBe("2000-01");
  expect(parseMonthKey("2026-07")).toEqual({ year: 2026, month: 7 });
  expect(parseMonthKey("2026-7")).toBeNull();
  expect(parseMonthKey("0099-01")).toBeNull();
  expect(parseMonthKey("1999-12")).toBeNull();
  expect(parseMonthKey("2101-01")).toBeNull();
  expect(formatMonthKey(99, 1)).toBeNull();
  expect(formatMonthKey(10000, 1)).toBeNull();
  expect(shiftCalendarMonth("2026-12", 1)).toBe("2027-01");
  expect(shiftCalendarMonth("2000-01", -1)).toBeNull();
  expect(shiftCalendarMonth("2100-12", 1)).toBeNull();
});
