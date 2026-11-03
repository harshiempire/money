import { expect, test } from "bun:test";
import {
  currentMonthKey,
  formatMonthKey,
  initialPickerYear,
  monthJumpOptions,
  parseMonthKey,
} from "./month-jump";

test("parseMonthKey accepts YYYY-MM and rejects partial or impossible months", () => {
  expect(parseMonthKey("2026-07")).toEqual({ year: 2026, month: 7 });
  expect(parseMonthKey("2026-7")).toBeNull();
  expect(parseMonthKey("2026-13")).toBeNull();
  expect(parseMonthKey("July")).toBeNull();
});

test("month jump links are full calendar months on the page that opened the picker", () => {
  const spend = monthJumpOptions(2026, "/spend");
  expect(spend).toHaveLength(12);
  expect(spend[6]).toMatchObject({
    monthKey: "2026-07",
    shortLabel: "Jul",
    longLabel: "July 2026",
    href: "/spend?month=2026-07",
  });

  const timeline = monthJumpOptions(2026, "/timeline");
  expect(timeline[6]?.href).toBe("/timeline?month=2026-07");

  const reimbursements = monthJumpOptions(2026, "/reimbursements");
  expect(reimbursements[0]?.href).toBe("/reimbursements?month=2026-01");
  expect(reimbursements[11]?.href).toBe("/reimbursements?month=2026-12");
});

test("picker opens on the selected year, then an anchor, then today", () => {
  const now = new Date(2026, 10, 3);
  expect(initialPickerYear("2025-07", "2026-10", now)).toBe(2025);
  expect(initialPickerYear(undefined, "2024-02", now)).toBe(2024);
  expect(initialPickerYear(undefined, undefined, now)).toBe(2026);
  expect(currentMonthKey(now)).toBe("2026-11");
  expect(formatMonthKey(2026, 7)).toBe("2026-07");
});
