import { describe, expect, test } from "bun:test";
import { dateWindows, daysBetween, parsePartialDate, stripDateSpans } from "./partial-date";

const TODAY = "2026-09-25";
const p = (s: string) => parsePartialDate(s, TODAY);

describe("parsePartialDate", () => {
  test("keeps the year empty when it wasn't said", () => {
    expect(p("26 Aug")).toEqual({ year: null, month: 8, day: 26 });
    expect(p("Aug 26")).toEqual({ year: null, month: 8, day: 26 });
    expect(p("26th of August")).toEqual({ year: null, month: 8, day: 26 });
    expect(p("26/08")).toEqual({ year: null, month: 8, day: 26 });
  });

  test("reads stated years", () => {
    expect(p("August 26, 2026")).toEqual({ year: 2026, month: 8, day: 26 });
    expect(p("26 Aug 2025")).toEqual({ year: 2025, month: 8, day: 26 });
    expect(p("26-08-2026")).toEqual({ year: 2026, month: 8, day: 26 });
    expect(p("26/8/26")).toEqual({ year: 2026, month: 8, day: 26 });
    expect(p("2026-08-26")).toEqual({ year: 2026, month: 8, day: 26 });
  });

  test("reads month-only and year-only", () => {
    expect(p("August")).toEqual({ year: null, month: 8, day: null });
    expect(p("Aug 2026")).toEqual({ year: 2026, month: 8, day: null });
    expect(p("2026")).toEqual({ year: 2026, month: null, day: null });
  });

  test("resolves today and yesterday against the given date", () => {
    expect(p("today")).toEqual({ year: 2026, month: 9, day: 25 });
    expect(p("yesterday")).toEqual({ year: 2026, month: 9, day: 24 });
  });

  test("reads numeric dates day-first and rejects impossible ones", () => {
    expect(p("08/26")).toBeNull(); // month 26
    expect(p("31 Sep")).toBeNull();
    expect(p("29 Feb 2025")).toBeNull();
    expect(p("29 Feb 2024")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(p("29 Feb")).toEqual({ year: null, month: 2, day: 29 });
  });

  test("returns null for things it can't read", () => {
    expect(p("last Tuesday")).toBeNull();
    expect(p("the 26th")).toBeNull();
    expect(p("26")).toBeNull();
    expect(p("")).toBeNull();
    expect(p("26 Aug 1850")).toBeNull();
  });
});

describe("dateWindows", () => {
  test("a full date becomes one window with slack", () => {
    expect(dateWindows({ year: 2026, month: 8, day: 26 }, [2025, 2026])).toEqual([
      { from: "2026-08-23", to: "2026-08-29", target: "2026-08-26" },
    ]);
  });

  test("a missing year expands to every year with data", () => {
    expect(dateWindows({ year: null, month: 8, day: 26 }, [2025, 2026])).toEqual([
      { from: "2025-08-23", to: "2025-08-29", target: "2025-08-26" },
      { from: "2026-08-23", to: "2026-08-29", target: "2026-08-26" },
    ]);
  });

  test("slack crosses month boundaries", () => {
    expect(dateWindows({ year: 2026, month: 9, day: 1 }, [])[0]).toEqual({
      from: "2026-08-29",
      to: "2026-09-04",
      target: "2026-09-01",
    });
  });

  test("month and year windows cover the whole period", () => {
    expect(dateWindows({ year: 2024, month: 2, day: null }, [])).toEqual([
      { from: "2024-02-01", to: "2024-02-29", target: null },
    ]);
    expect(dateWindows({ year: 2026, month: null, day: null }, [])).toEqual([
      { from: "2026-01-01", to: "2026-12-31", target: null },
    ]);
  });

  test("Feb 29 without a year only matches leap years", () => {
    expect(dateWindows({ year: null, month: 2, day: 29 }, [2024, 2025])).toHaveLength(1);
  });
});

test("daysBetween", () => {
  expect(daysBetween("2026-08-26", "2026-08-28")).toBe(2);
  expect(daysBetween("2026-08-28", "2026-08-26")).toBe(-2);
});

test("stripDateSpans leaves amounts, removes dates", () => {
  const t = (s: string) => stripDateSpans(s).replace(/\s+/g, " ").trim();
  expect(t("₹760 on 28 Aug 2026")).toBe("₹760 on");
  expect(t("the 26/8 one for 500")).toBe("the one for 500");
  expect(t("Aug 26th, paid rs 2026")).toBe(", paid rs 2026");
  expect(t("₹2026 in 2025")).toBe("₹2026 in");
});
