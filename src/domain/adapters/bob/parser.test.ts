import { describe, expect, test } from "bun:test";
import { extractPeriod } from "./parser";

describe("Bank of Baroda statement period", () => {
  test("parses abbreviated month names from eStatements", () => {
    expect(
      extractPeriod([
        "Statement Period from Jul 01, 2026 to Jul 31, 2026",
      ]),
    ).toEqual({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
  });

  test("continues to parse full month names", () => {
    expect(
      extractPeriod([
        "Statement Period from July 01, 2026 to July 31, 2026",
      ]),
    ).toEqual({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
  });

  test("does not manufacture an invalid date for an unknown month", () => {
    expect(
      extractPeriod([
        "Statement Period from Smarch 01, 2026 to Smarch 31, 2026",
      ]),
    ).toEqual({
      periodStart: null,
      periodEnd: null,
    });
  });
});
