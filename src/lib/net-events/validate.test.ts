import { describe, expect, test } from "bun:test";
import {
  balanceAllocationsToExpectedNet,
  buildApr16ScenarioLegs,
  buildMay8ScenarioLegs,
  sumPayableLegs,
  sumReceivableLegs,
  validateNetEventInvariant,
} from "./validate";

describe("validateNetEventInvariant", () => {
  test("16-Apr Starbucks/biker scenario balances at ₹149 inflow", () => {
    const legs = buildApr16ScenarioLegs("participant-starbucks", "owed-biker");
    expect(sumReceivableLegs(legs)).toBe(44400);
    expect(sumPayableLegs(legs)).toBe(29500);
    expect(validateNetEventInvariant(legs, 14900, 0)).toEqual({ ok: true });
  });

  test("8-May vyapar/milk scenario balances at ₹277.50 inflow", () => {
    const legs = buildMay8ScenarioLegs("participant-vyapar", "owed-milk");
    expect(sumReceivableLegs(legs)).toBe(79800);
    expect(sumPayableLegs(legs)).toBe(52050);
    expect(validateNetEventInvariant(legs, 27750, 0)).toEqual({ ok: true });
  });

  test("rejects invariant mismatch", () => {
    const legs = buildApr16ScenarioLegs("p1", "o1");
    const result = validateNetEventInvariant(legs, 10000, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("does not match bank delta");
    }
  });

  test("pure offset zero bank delta", () => {
    const legs = buildApr16ScenarioLegs("p1", "o1").slice(1);
    const receivableOnly = legs.filter((l) => l.kind === "receivable");
    const payableOnly = legs.filter((l) => l.kind === "payable");
    expect(
      validateNetEventInvariant(
        [...receivableOnly, ...payableOnly],
        0,
        0,
      ).ok,
    ).toBe(true);
  });
});

describe("balanceAllocationsToExpectedNet", () => {
  test("Nitin-style 14 paise residual: shaves largest receivable", () => {
    // 284.04 − 88.50 = 195.54 but bank inflow is 195.40
    const result = balanceAllocationsToExpectedNet(
      { bookmyshow: 28404 },
      { mfc: 8850 },
      { bookmyshow: 28404, empty: 13500 },
      { mfc: 8850 },
      19540,
    );
    expect(result).not.toBeNull();
    expect(result!.receivableAllocs.bookmyshow).toBe(28390); // 284.04 − 0.14
    expect(result!.payableAllocs.mfc).toBe(8850);
    expect(
      result!.receivableAllocs.bookmyshow - result!.payableAllocs.mfc,
    ).toBe(19540);
    expect(result!.adjusted).toEqual({
      side: "receivable",
      id: "bookmyshow",
      byPaise: -14,
    });
  });

  test("returns null when already balanced", () => {
    expect(
      balanceAllocationsToExpectedNet(
        { a: 10000 },
        {},
        { a: 10000 },
        {},
        10000,
      ),
    ).toBeNull();
  });

  test("grows an allocated payable when no single receivable can absorb residual", () => {
    // R=50, P=50, expected=-100 → residual +100; shaving r (max 50) can't absorb it
    const result = balanceAllocationsToExpectedNet(
      { r: 50 },
      { p: 50 },
      { r: 50 },
      { p: 200 },
      -100,
    );
    expect(result!.payableAllocs.p).toBe(150);
    expect(result!.receivableAllocs.r).toBe(50);
    expect(result!.adjusted).toEqual({
      side: "payable",
      id: "p",
      byPaise: 100,
    });
  });

  test("never grows an unallocated line — returns null instead", () => {
    // Residual +100 can only be absorbed by p's cap, but the user never
    // allocated p; silently settling against it would hit the wrong person.
    const result = balanceAllocationsToExpectedNet(
      { r: 50 },
      {},
      { r: 50 },
      { p: 200 },
      -50,
    );
    expect(result).toBeNull();
  });

  test("never grows an unallocated receivable — returns null instead", () => {
    // residual −100: only the zero-alloc receivable "other" has cap room
    // (r is at its cap, p is too small to shave)
    const result = balanceAllocationsToExpectedNet(
      { r: 50 },
      { p: 50 },
      { r: 50, other: 500 },
      { p: 50 },
      100,
    );
    expect(result).toBeNull();
  });
});
