import { describe, expect, test } from "bun:test";
import type { PayableOption, ReceivableOption } from "@/lib/net-events/load-net-settle-data";
import {
  guidedSettlementLegs as plan,
  personSettlementSelection,
  selectionAllocations,
  selectionTotals,
  settlementFix,
  settlementGroups,
  settlementPersonKey,
  suggestSettlement,
  type SettlementPayment,
} from "./net-settlement-plan";
import { validateNetEventInvariant } from "@/lib/net-events/validate";

const guidedSettlementLegs = (...args: Parameters<typeof plan>) => {
  const result = plan(...args);
  if (!result.ok) throw new Error(result.message);
  return result.legs;
};
const receivable = (
  id: string,
  personName: string,
  amount: number,
  date = "2026-05-12",
): ReceivableOption => ({
  id,
  personName,
  personId: null,
  expectedAmountPaise: amount,
  outstandingPaise: amount,
  splitTransactionDate: date,
  splitTransactionDescription: `Bill ${id}`,
});
const payable = (
  id: string,
  personName: string,
  amount: number,
): PayableOption => ({
  id,
  personName,
  personId: null,
  amountPaise: amount,
  outstandingPaise: amount,
  incurredDate: "2026-05-20",
  description: `Bill ${id}`,
  categoryId: null,
});
const payment: SettlementPayment = {
  id: "bank",
  date: "2026-05-28",
  description: "Goa payment",
  personName: "Arjun",
  direction: "credit",
  amountPaise: 476000,
};
const groupScenario = () =>
  settlementGroups(
    [
      receivable("arjun", "Arjun", 420000),
      receivable("priya", "Priya", 241000),
      receivable("kabir", "Kabir", 150000),
    ],
    [payable("neha", "Neha", 185000)],
  );

describe("person keys and draft allocations", () => {
  const bothWays = settlementGroups(
    [{ ...receivable("uber", "Alex", 60000), personId: "p1" }],
    [{ ...payable("dinner", "Alex", 185000), personId: "p1" }],
  );
  test("one saved person owing in both directions keeps one id key", () => {
    expect(settlementPersonKey(bothWays, " alex ")).toBe("id:p1");
    expect(selectionTotals(bothWays, personSettlementSelection(bothWays, "Alex", "bank"))).toEqual({
      receivable: 60000,
      payable: 185000,
      net: -125000,
    });
  });
  test("an unbalanced selection still produces a draft, oldest bill first", () => {
    const groups = settlementGroups(
      [receivable("a", "Neha", 1000, "2026-01-01"), receivable("b", "Neha", 2000, "2026-02-01")],
      [],
    );
    const key = groups[0].key;
    expect(selectionAllocations(groups, { [key]: 1500 })).toEqual([
      { kind: "receivable", id: "a", paise: 1000, cap: 1000 },
      { kind: "receivable", id: "b", paise: 500, cap: 2000 },
    ]);
    expect(selectionAllocations(groups, { [key]: 3001 })).toBeNull();
  });
});

describe("approved one-person settlement", () => {
  const groups = settlementGroups(
    [receivable("uber", "Neha", 60000)],
    [payable("dinner", "Neha", 185000)],
  );
  test("offset alone cancels 600 on each side and leaves 1250 payable", () => {
    const picked = personSettlementSelection(groups, " neHA ", "offset");
    expect(selectionTotals(groups, picked)).toEqual({
      receivable: 60000,
      payable: 60000,
      net: 0,
    });
    const legs = guidedSettlementLegs(groups, picked, "offset");
    expect(legs.map((leg) => leg.amountPaise)).toEqual([60000, 60000]);
    expect(legs.every((leg) => leg.method === "offset")).toBe(true);
    expect(validateNetEventInvariant(legs, 0, 0)).toEqual({ ok: true });
  });
  test("outgoing bank payment clears both sides without a fictitious inflow", () => {
    const picked = personSettlementSelection(groups, "Neha", "bank");
    const legs = guidedSettlementLegs(groups, picked, "bank", {
      ...payment,
      direction: "debit",
      amountPaise: 125000,
    });
    expect(legs.every((leg) => leg.method === "offset")).toBe(true);
    expect(validateNetEventInvariant(legs, 0, 125000)).toEqual({ ok: true });
    expect(legs.map((leg) => leg.expectedOutstandingPaise)).toEqual([
      60000, 185000,
    ]);
  });
  test("cash records only 1250 exchanged plus equal 600 offsets", () => {
    const legs = guidedSettlementLegs(
      groups,
      personSettlementSelection(groups, "Neha", "cash"),
      "cash",
    );
    expect(
      legs
        .filter((leg) => leg.method === "cash")
        .map((leg) => [leg.kind, leg.amountPaise]),
    ).toEqual([["payable", 125000]]);
    expect(
      legs
        .filter((leg) => leg.method === "offset")
        .map((leg) => leg.amountPaise),
    ).toEqual([60000, 60000]);
    expect(validateNetEventInvariant(legs, 0, 0)).toEqual({ ok: true });
  });
  test("cash received works in the opposite direction, including odd paise", () => {
    const rows = settlementGroups(
      [receivable("r", "Neha", 185001)],
      [payable("p", "Neha", 60000)],
    );
    const legs = guidedSettlementLegs(
      rows,
      personSettlementSelection(rows, "Neha", "cash"),
      "cash",
    );
    expect(
      legs
        .filter((leg) => leg.method === "cash")
        .map((leg) => [leg.kind, leg.amountPaise]),
    ).toEqual([["receivable", 125001]]);
    expect(validateNetEventInvariant(legs, 0, 0)).toEqual({ ok: true });
  });
});

describe("approved group settlement", () => {
  test("suggests the exact 4200 + 2410 - 1850 combination and excludes Kabir", () => {
    const groups = groupScenario(),
      picked = suggestSettlement(groups, 476000, "Arjun");
    expect(picked).toEqual({
      "receivable:name:arjun": 420000,
      "receivable:name:priya": 241000,
      "payable:name:neha": 185000,
    });
    const legs = guidedSettlementLegs(groups, picked, "bank", payment);
    expect(
      legs
        .filter((leg) => leg.method === "bank")
        .reduce((sum, leg) => sum + leg.amountPaise, 0),
    ).toBe(476000);
    expect(validateNetEventInvariant(legs, 476000, 0)).toEqual({ ok: true });
  });
  test("removing Neha offers partial Priya 560, preserving 1850 open", () => {
    const groups = groupScenario(),
      picked = { ...suggestSettlement(groups, 476000), "payable:name:neha": 0 };
    const fix = settlementFix(groups, picked, 476000)!;
    expect(fix.group.personName).toBe("Priya");
    expect(fix.next["receivable:name:priya"]).toBe(56000);
    expect(fix.remainingOpenPaise).toBe(185000);
    expect(selectionTotals(groups, fix.next).net).toBe(476000);
    expect(fix.next["payable:name:neha"]).toBe(0);
  });
  test("adding Kabir offers removing him without affecting the others", () => {
    const groups = groupScenario(),
      original = suggestSettlement(groups, 476000);
    const fix = settlementFix(
      groups,
      { ...original, "receivable:name:kabir": 150000 },
      476000,
    )!;
    expect(fix.next).toEqual({ ...original, "receivable:name:kabir": 0 });
    expect(fix.remainingOpenPaise).toBe(150000);
  });
  test("partial allocations consume the oldest bills first and carry current caps", () => {
    const groups = settlementGroups(
      [
        receivable("new", "Arjun", 30001, "2026-05-20"),
        receivable("old", " arjun ", 20000, "2026-05-01"),
      ],
      [],
    );
    const legs = guidedSettlementLegs(
      groups,
      { "receivable:name:arjun": 40001 },
      "bank",
      { ...payment, amountPaise: 40001 },
    );
    expect(
      legs.map((leg) => [
        leg.kind === "receivable" ? leg.splitParticipantId : "",
        leg.amountPaise,
        leg.expectedOutstandingPaise,
      ]),
    ).toEqual([
      ["old", 20000, 20000],
      ["new", 20001, 30001],
    ]);
  });
  test("refuses mismatched payments and invalid amounts instead of rounding", () => {
    const groups = groupScenario();
    expect(() =>
      guidedSettlementLegs(
        groups,
        { "receivable:name:arjun": 420000 },
        "bank",
        payment,
      ),
    ).toThrow("do not match");
    for (const amount of [-1, 420001, 1.5, NaN, Infinity])
      expect(() =>
        guidedSettlementLegs(groups, { "receivable:name:arjun": amount }, "cash"),
      ).toThrow("exceeds");
    expect(() =>
      guidedSettlementLegs(groups, { "receivable:name:arjun": 420000 }, "offset"),
    ).toThrow("equal");
    expect(suggestSettlement(groups, 1)).toEqual({});
  });
  test("offset selection ignores a previously selected bank payment", () => {
    const groups = settlementGroups(
      [receivable("r", "A", 100)],
      [payable("p", "B", 100)],
    );
    const legs = guidedSettlementLegs(
      groups,
      { "receivable:name:a": 100, "payable:name:b": 100 },
      "offset",
      payment,
    );
    expect(legs.every((leg) => leg.method === "offset")).toBe(true);
  });
});

test('saved IDs remain separate and missing IDs resolve only against unique saved people', () => {
  const groups = settlementGroups([
    { ...receivable('one', 'Finch', 100), personId: 'p1' },
    { ...receivable('two', 'FINCH', 200), personId: 'p2' },
    receivable('missing', ' Finch ', 300),
  ], []);
  expect(new Set(groups.map(g => g.personKey))).toEqual(new Set(['id:p1', 'id:p2', 'name:finch']));
  const unique = settlementGroups([{ ...receivable('one', 'Finch', 100), personId: 'p1' }, receivable('missing', ' FINCH ', 300)], []);
  expect(unique).toHaveLength(1);
  expect(unique[0].outstandingPaise).toBe(400);
});
test('planning refusals are values with existing ledger codes', () => {
  expect(plan(groupScenario(), { 'receivable:name:arjun': 1.5 }, 'cash')).toMatchObject({ ok: false, code: 'invalid_input' });
});
