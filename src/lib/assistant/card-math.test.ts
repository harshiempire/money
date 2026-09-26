import { describe, expect, test } from "bun:test";
import {
  equalShares,
  fillReceivablesLargestFirst,
  netBalance,
  resolvePerson,
  splitBalance,
  typedPaise,
} from "./card-math";
import type { NetLine } from "./types";

describe("equalShares", () => {
  test("₹760 half each", () => {
    expect(equalShares(76000, 1)).toEqual({ yours: 38000, each: 38000 });
  });
  test("the odd paisa goes to you", () => {
    expect(equalShares(10001, 1)).toEqual({ yours: 5001, each: 5000 });
    expect(equalShares(10000, 2)).toEqual({ yours: 3334, each: 3333 });
  });
});

describe("splitBalance", () => {
  test("balanced half split", () => {
    expect(splitBalance(76000, "380.00", [{ name: "Nitin", amt: "380.00" }])).toMatchObject({
      residualPaise: 0,
      ok: true,
    });
  });
  test("blank share means the remainder", () => {
    const b = splitBalance(76000, "", [{ name: "Nitin", amt: "500" }]);
    expect(b.yourSharePaise).toBe(26000);
    expect(b.ok).toBe(true);
  });
  test("unaccounted and over", () => {
    expect(splitBalance(76000, "100", [{ name: "Nitin", amt: "380" }]).residualPaise).toBe(28000);
    expect(splitBalance(76000, "500", [{ name: "Nitin", amt: "380" }]).residualPaise).toBe(-12000);
  });
  test("needs a named participant and readable amounts", () => {
    expect(splitBalance(76000, "", [{ name: "", amt: "380" }]).ok).toBe(false);
    expect(splitBalance(76000, "", [{ name: "Nitin", amt: "3.805" }])).toMatchObject({ invalid: true, ok: false });
  });
});

test("typedPaise", () => {
  expect(typedPaise("")).toBe(0);
  expect(typedPaise("380.5")).toBe(38050);
  expect(Number.isNaN(typedPaise("abc"))).toBe(true);
});

describe("resolvePerson", () => {
  const known = ["Nitin", "Nisha", "Satvik"];
  test("exact, case-insensitive", () => {
    expect(resolvePerson("nitin", known)).toEqual({ name: "Nitin", known: true });
  });
  test("unique prefix", () => {
    expect(resolvePerson("Satv", known)).toEqual({ name: "Satvik", known: true });
  });
  test("ambiguous or unknown stays as said", () => {
    expect(resolvePerson("Ni", known)).toEqual({ name: "Ni", known: false });
    expect(resolvePerson("Nit", known)).toEqual({ name: "Nitin", known: true });
    expect(resolvePerson("Rahul", known)).toEqual({ name: "Rahul", known: false });
  });
});

const line = (id: string, outstandingPaise: number, val = ""): NetLine => ({
  id,
  person: "Nitin",
  date: "2026-08-03",
  desc: id,
  outstandingPaise,
  val,
});

describe("net settle card", () => {
  test("the handoff example balances", () => {
    const recv = [line("uber", 124000, "1240.00"), line("toit", 38000, "380.00")];
    const pay = [line("movie", 50000, "500.00")];
    expect(netBalance(112000, recv, pay)).toMatchObject({ residualPaise: 0, ok: true });
  });

  test("flags a line over its outstanding amount", () => {
    const b = netBalance(112000, [line("uber", 124000, "1300")], [line("movie", 50000, "180")]);
    expect(b.overLine?.id).toBe("uber");
    expect(b.ok).toBe(false);
  });

  test("adjust fills the largest receivable first", () => {
    const filled = fillReceivablesLargestFirst(
      112000,
      [line("toit", 38000), line("uber", 124000)],
      [line("movie", 50000, "500.00")],
    );
    expect(filled.map((l) => l.val)).toEqual(["380.00", "1240.00"]);
    const partial = fillReceivablesLargestFirst(50000, [line("toit", 38000), line("uber", 124000)], []);
    expect(partial.map((l) => l.val)).toEqual(["", "500.00"]);
  });
});
