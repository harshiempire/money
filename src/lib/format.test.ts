import { describe, expect, test } from "bun:test";
import { formatPaiseShort } from "./format";

describe("formatPaiseShort", () => {
  test("formats integer rupees below ₹1,000", () => {
    expect(formatPaiseShort(0)).toBe("₹0");
    expect(formatPaiseShort(95000)).toBe("₹950");
  });

  test("formats thousands with one decimal", () => {
    expect(formatPaiseShort(100000)).toBe("₹1k");
    expect(formatPaiseShort(123456)).toBe("₹1.2k");
    expect(formatPaiseShort(9999900)).toBe("₹100k");
  });

  test("formats lakhs and crores", () => {
    expect(formatPaiseShort(10_000_000)).toBe("₹1L");
    expect(formatPaiseShort(34_000_000)).toBe("₹3.4L");
    expect(formatPaiseShort(1_000_000_000)).toBe("₹1Cr");
  });

  test("handles negatives and null", () => {
    expect(formatPaiseShort(-123456)).toBe("−₹1.2k");
    expect(formatPaiseShort(null)).toBe("—");
    expect(formatPaiseShort(undefined)).toBe("—");
  });
});
