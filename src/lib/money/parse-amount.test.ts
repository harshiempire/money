import { describe, expect, test } from "bun:test";
import { parseAmountToPaise } from "./parse-amount";

describe("parseAmountToPaise", () => {
  test("reads whole rupees in the usual spellings", () => {
    expect(parseAmountToPaise("100")).toBe(10000);
    expect(parseAmountToPaise("₹100")).toBe(10000);
    expect(parseAmountToPaise("₹ 100")).toBe(10000);
    expect(parseAmountToPaise("Rs. 100")).toBe(10000);
    expect(parseAmountToPaise("rs100")).toBe(10000);
    expect(parseAmountToPaise("INR 100")).toBe(10000);
    expect(parseAmountToPaise("100 rupees")).toBe(10000);
    expect(parseAmountToPaise("100/-")).toBe(10000);
  });

  test("keeps paise exact without float drift", () => {
    expect(parseAmountToPaise("0.29")).toBe(29);
    expect(parseAmountToPaise("100.5")).toBe(10050);
    expect(parseAmountToPaise("100.05")).toBe(10005);
    expect(parseAmountToPaise("1234.99")).toBe(123499);
  });

  test("accepts Indian and western digit grouping", () => {
    expect(parseAmountToPaise("₹1,00,000.50")).toBe(10000050);
    expect(parseAmountToPaise("100,000")).toBe(10000000);
  });

  test("refuses anything it cannot read exactly", () => {
    expect(parseAmountToPaise("100.555")).toBeNull();
    expect(parseAmountToPaise("hundred")).toBeNull();
    expect(parseAmountToPaise("-100")).toBeNull();
    expect(parseAmountToPaise("1e3")).toBeNull();
    expect(parseAmountToPaise("")).toBeNull();
    expect(parseAmountToPaise("₹")).toBeNull();
    expect(parseAmountToPaise("99999999999999999999")).toBeNull();
  });
});
