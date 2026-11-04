import { expect, test } from "bun:test";
import { Schema } from "effect";
import { Money, moneyPaise, splitAmounts, allocateOldestFirst, validateAllocations, existingPerson } from "./write-rules";
import { RelationalInputs, RelationalOutput } from "./relational-schemas";

test("money parsing uses decimal digits, rejects rounding and overflow", () => {
  for (const [value, paise] of [["0", 0], ["0.01", 1], [0.29, 29], ["100.10", 10010], ["90071992547409.91", Number.MAX_SAFE_INTEGER]] as const)
    expect(moneyPaise(value)).toBe(paise);
  for (const bad of ["1.001", 1.001, 0.1 + 0.2, "1e2", "-1", -1, " 1", ".5", "1.", "01.00", "1,000", "90071992547409.92", Infinity, NaN]) {
    expect(Schema.is(Money)(bad)).toBe(false);
    expect(() => moneyPaise(bad)).toThrow();
  }
});
test("equal splits keep every paise and explicit splits report the gap", () => {
  expect(splitAmounts(10001, [undefined, undefined], undefined, true)).toEqual({ yours: 3335, participants: [3333, 3333] });
  expect(splitAmounts(10000, ["50"], "50", false)).toEqual({ yours: 5000, participants: [5000] });
  expect(() => splitAmounts(10000, ["49.99"], "50", false)).toThrow("short by ₹0.01");
  expect(() => splitAmounts(10000, ["50.01"], "50", false)).toThrow("over by ₹0.01");
  expect(() => splitAmounts(10000, [undefined], "50", false)).toThrow("require");
  expect(() => splitAmounts(10000, ["50"], undefined, true)).toThrow("cannot also");
  expect(() => splitAmounts(1, ["90071992547409.91", "90071992547409.91"], "0", false)).toThrow("over by ₹180143985094819.81");
});
test("participants require exact trimmed case-insensitive names or explicit creation", () => {
  expect(existingPerson(["Kiran", "Ravi Teja", "Ravi Kumar"], " kIrAn ")).toBe("Kiran");
  expect(() => existingPerson(["Ravi Teja", "Ravi Kumar"], "Ravi")).toThrow("Close names: Ravi Teja, Ravi Kumar");
  expect(() => existingPerson(["Kiran"], "New Person")).toThrow("No close names");
  expect(existingPerson(["Kiran"], " New Person ", true)).toBe("New Person");
});
const shares = [
  { id: "b", date: "2026-04-20", order: "2026-05-01", leftPaise: 3667 },
  { id: "c", date: "2026-05-01", order: "2026-05-02", leftPaise: 5833 },
  { id: "a", date: "2026-04-20", order: "2026-04-01", leftPaise: 600 },
  { id: "d", date: "2026-05-13", order: "2026-05-13", leftPaise: 6700 },
];
test("oldest-first allocations span bills, partials and multiple inflows", () => {
  const first = allocateOldestFirst(10000, shares);
  expect(first).toEqual({ ok: true, allocations: [{ id: "a", amountPaise: 600, leftPaise: 0 }, { id: "b", amountPaise: 3667, leftPaise: 0 }, { id: "c", amountPaise: 5733, leftPaise: 100 }], remaining: 0 });
  const nextShares = shares.map(s => ({ ...s, leftPaise: (first.ok ? first.allocations : []).find(a => a.id === s.id)?.leftPaise ?? s.leftPaise }));
  expect(allocateOldestFirst(5500, nextShares)).toEqual({ ok: true, allocations: [{ id: "c", amountPaise: 100, leftPaise: 0 }, { id: "d", amountPaise: 5400, leftPaise: 1300 }], remaining: 0 });
  expect((allocateOldestFirst(600, shares) as { allocations: unknown }).allocations).toEqual([{ id: "a", amountPaise: 600, leftPaise: 0 }]);
  expect((allocateOldestFirst(20000, shares) as { remaining: number }).remaining).toBe(3200);
  expect((allocateOldestFirst(100, []) as { remaining: number }).remaining).toBe(100);
});
test("explicit allocations aggregate repeated targets and refuse either cap", () => {
  expect(validateAllocations(600, shares, [{ id: "a", amountPaise: 200 }, { id: "a", amountPaise: 400 }])).toEqual({ ok: true, allocations: [{ id: "a", amountPaise: 600, leftPaise: 0 }], remaining: 0 });
  expect(validateAllocations(700, shares, [{ id: "a", amountPaise: 400 }, { id: "a", amountPaise: 300 }])).toMatchObject({ ok: false, message: expect.stringContaining("outstanding") });
  expect(validateAllocations(500, shares, [{ id: "a", amountPaise: 600 }])).toMatchObject({ ok: false, message: expect.stringContaining("unallocated") });
  expect(validateAllocations(500, shares, [{ id: "foreign", amountPaise: 10 }])).toMatchObject({ ok: false, message: expect.stringContaining("isn't available") });
});
test("write schemas require keys, valid money and revisions, output includes exact allocation results", () => {
  const base = { ref: "txn_x", rev: "rev_x", participants: [{ person: "Kiran" }], equal: true, idempotency_key: "test-key-123" };
  expect(Schema.is(RelationalInputs.create_split)(base)).toBe(true);
  expect(Schema.is(RelationalInputs.create_split)({ ...base, replace_existing: true })).toBe(false);
  expect(Schema.is(RelationalInputs.create_split)({ ...base, replace_existing: true, split_rev: "spr_current" })).toBe(true);
  expect(Schema.is(RelationalInputs.delete_split)(base)).toBe(false);
  expect(Schema.is(RelationalInputs.delete_split)({ ...base, split_rev: "spr_current" })).toBe(true);
  expect(Schema.is(RelationalInputs.create_split)({ ...base, rev: undefined })).toBe(false);
  expect(Schema.is(RelationalInputs.create_split)({ ...base, idempotency_key: "short" })).toBe(false);
  expect(Schema.is(RelationalInputs.create_split)({ ...base, reason: "x".repeat(201) })).toBe(false);
  expect(Schema.is(RelationalInputs.record_settlement)({ inflow_ref: "txn_x", person: "Kiran", allocations: [{ share_ref: "shr_x", amount: "0.001" }], idempotency_key: "test-key-123" })).toBe(false);
  expect(Schema.is(RelationalInputs.add_owed_expense)({ person: "Kiran", date: "2026-02-30", what: "Food", amount: 1, idempotency_key: "test-key-123" })).toBe(false);
  expect(Schema.is(RelationalOutput)({ applied: true, change_id: "change", summary: "Saved", refs: ["shr_x"], allocations: [{ share_ref: "shr_x", person: "Kiran", amount: "1.00", left: "2.00" }], unallocated: "0.00", left_open: "2.00" })).toBe(true);
  expect(Schema.is(RelationalOutput)({ applied: false, errors: [{ code: "stale", message: "Changed", current_rev: "rev_x" }] })).toBe(true);
});

test("create_person never silently creates a near-miss of an existing person", () => {
  const names = ["Kiran", "Ravi Teja", "Ravi Kumar"];
  expect(() => existingPerson(names, "Ravi", true)).toThrow("Not creating 'Ravi': it is close to Ravi Teja, Ravi Kumar");
  expect(() => existingPerson(names, "Ravi", true, ["ravi teja"])).toThrow("it is close to Ravi Kumar");
  expect(existingPerson(names, " Ravi ", true, ["Ravi Teja", "RAVI KUMAR"])).toBe("Ravi");
  expect(existingPerson(names, "Ravi Teja", true)).toBe("Ravi Teja");
  expect(existingPerson(names, "Meera", true)).toBe("Meera");
});
