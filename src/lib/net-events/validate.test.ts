import { describe, expect, test } from "bun:test";
import {
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
