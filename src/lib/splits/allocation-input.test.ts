import { describe, expect, test } from "bun:test";
import { parseAllocationInputs, parseRupees } from "./allocation-input";

// Agreed in the Codex/Claude review dialogue (room money-review-34075afa-0906-r2):
// the Settle dialog counted a negative on screen but dropped it before
// submitting, so a save could silently clear an existing allocation.

describe("parseRupees", () => {
  test("blank and whitespace mean no allocation", () => {
    expect(parseRupees("")).toEqual({ kind: "blank" });
    expect(parseRupees("   ")).toEqual({ kind: "blank" });
  });

  test("whole rupees and one or two decimals convert exactly", () => {
    expect(parseRupees("12")).toEqual({ kind: "paise", paise: 1200 });
    expect(parseRupees("12.5")).toEqual({ kind: "paise", paise: 1250 });
    expect(parseRupees("12.50")).toEqual({ kind: "paise", paise: 1250 });
    expect(parseRupees("12.")).toEqual({ kind: "paise", paise: 1200 });
  });

  test("does not go through float arithmetic", () => {
    // 0.07 * 100 === 7.000000000000001 in IEEE-754.
    expect(parseRupees("0.07")).toEqual({ kind: "paise", paise: 7 });
  });

  test("three decimals are rejected, not rounded", () => {
    expect(parseRupees("12.345")).toEqual({ kind: "invalid" });
  });

  test("negatives, trailing junk, exponents, bare points and commas are invalid", () => {
    for (const raw of ["-10", "12abc", "1e3", ".5", "1,000", "abc", "₹12"]) {
      expect(parseRupees(raw)).toEqual({ kind: "invalid" });
    }
  });

  test("twelve integer digits convert exactly; thirteen are rejected", () => {
    expect(parseRupees("999999999999")).toEqual({
      kind: "paise",
      paise: 99_999_999_999_900,
    });
    expect(Number.isSafeInteger(99_999_999_999_900)).toBe(true);
    expect(parseRupees("1000000000000")).toEqual({ kind: "invalid" });
  });
});

describe("parseAllocationInputs", () => {
  const label = (id: string) => ({ a: "Aryan", b: "Bob" })[id] ?? id;

  test("blank rows are dropped and the rest are kept", () => {
    const r = parseAllocationInputs({ a: "", b: "2.50" }, label);
    expect(r.ok).toBe(true);
    expect(r.allocations).toEqual([{ splitParticipantId: "b", amountPaise: 250 }]);
  });

  test("zero rows are dropped like blanks", () => {
    const r = parseAllocationInputs({ a: "0", b: "2.50" }, label);
    expect(r.ok).toBe(true);
    expect(r.allocations).toEqual([{ splitParticipantId: "b", amountPaise: 250 }]);
  });

  test("a negative fails the whole submission and names the participant", () => {
    const r = parseAllocationInputs({ a: "-10", b: "2.50" }, label);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].splitParticipantId).toBe("a");
    expect(r.problems[0].message).toContain("Aryan");
    expect(r.problems[0].message).toContain('"-10"');
  });

  test("all blank is a valid, intentional empty allocation", () => {
    const r = parseAllocationInputs({ a: "", b: "" }, label);
    expect(r.ok).toBe(true);
    expect(r.allocations).toEqual([]);
  });
});
