import { expect, test } from "bun:test";
import { Schema } from "effect";
import { findPayments, amountPaise } from "./find-payments";
import { FindPaymentsInput, FindPaymentsOutput } from "./read-schemas";
import { fixtureTxn, fixtureView } from "./read-fixtures";
import type { McpReadModel } from "./read-model";

const empty = (): McpReadModel => ({ transactions: [], people: [], payees: [], splits: [], shares: [], owed: [], settlements: [], netEvents: [] });
test("ranking prefers exact transaction, then exact share, then ±2%, with explicit reasons", () => {
  const model = empty();
  model.transactions = [fixtureTxn("near", { amountPaise: 27948 }), fixtureTxn("exact", { amountPaise: 27400 }), fixtureTxn("share")];
  model.splits = [{ id: "s", transactionId: "share", totalPaise: 56700, yourSharePaise: 29300 }];
  model.shares = [{ id: "p", splitId: "s", personName: "Kiran", expectedAmountPaise: 27400 }];
  const result = findPayments(fixtureView(model), { amount: "274" });
  expect(result.candidates.map((c) => c.amount)).toEqual(["274.00", "567.00", "279.48"]);
  expect(result.candidates.map((c) => c.score)).toEqual([100, 90, 50]);
  expect(result.candidates[1].reasons).toEqual(["exact share amount for Kiran"]);
  expect(result.candidates[1].split_summary).toMatchObject({ total: "567.00", shares: [{ person: "Kiran", expected: "274.00", left: "274.00" }] });
  model.transactions[0].amountPaise++;
  expect(findPayments(fixtureView(model), { amount: "274" }).candidates).toHaveLength(2);
  expect(Schema.is(FindPaymentsOutput)(result)).toBe(true);
});

test("date ranking is based on calendar distance with a default ±7-day window and explicit range override", () => {
  const model = empty();
  model.transactions = ["2026-07-31", "2026-07-29", "2026-08-07", "2026-08-08"].map((txnDate) => fixtureTxn(txnDate, { txnDate }));
  const view = fixtureView(model);
  const found = findPayments(view, { amount: "567", date: "2026-07-31" });
  expect(found.candidates.map((t) => t.date)).toEqual(["2026-07-31", "2026-07-29", "2026-08-07"]);
  expect(found.candidates[1].reasons).toContain("2 days from 2026-07-31");
  expect(findPayments(view, { text: "rooster", date: "2026-07-31", from: "2026-08-08" }).candidates.map((t) => t.date)).toEqual(["2026-08-08"]);
});

test("person matching recognizes split participants, notes and learned handles", () => {
  const view = fixtureView();
  const result = findPayments(view, { amount: "100", person: " kiran ", direction: "received" });
  expect(result.candidates).toHaveLength(5);
  expect(result.candidates.every((t) => t.reasons.some((r) => r.includes("handle seen settling Kiran")))).toBe(true);
  expect(findPayments(view, { amount: "274", person: "Kiran" }).candidates[0].reasons).toContain("has a split with Kiran");
  const model = empty(); model.transactions = [fixtureTxn("note", { note: "Paid for Kiran" })];
  expect(findPayments(fixtureView(model), { person: "Kiran" }).candidates[0].reasons).toEqual(["note mentions Kiran"]);
});

test("text matches every unredacted field and all supplied filters apply", () => {
  const view = fixtureView();
  for (const text of ["ROOSTER", "rooster@bank", "12345678"]) expect(findPayments(view, { text }).candidates.length).toBeGreaterThan(0);
  expect(findPayments(view, { amount: "1", text: "rooster" }).candidates).toEqual([]);
  expect(findPayments(view, { text: "rooster", direction: "received" }).candidates).toEqual([]);
  expect(findPayments(view, { person: "Kiran", limit: 1 }).candidates).toHaveLength(1);
});

test("search validates at least one substantive signal, date validity, money and limits", () => {
  for (const input of [{}, { date: "2026-07-31" }, { direction: "received" }, { text: " " }, { person: "" }, { amount: "0" }, { amount: "1.001" }, { amount: "-1" }, { amount: "10", limit: 26 }, { amount: "10", from: "2026-08-01", to: "2026-07-31" }, { text: "x", date: "2026-02-30" }]) {
    expect(Schema.is(FindPaymentsInput)(input)).toBe(false);
  }
  expect(() => findPayments(fixtureView(), {})).toThrow();
  expect(amountPaise("0.01")).toBe(1);
  expect(amountPaise("9999999999999.99")).toBe(999999999999999);
});


test("amount and person must identify the same share; transaction amounts retain person evidence", () => {
  const model = empty();
  model.transactions = [fixtureTxn("bill")];
  model.splits = [{ id: "split", transactionId: "bill", totalPaise: 56700, yourSharePaise: 28300 }];
  model.shares = [
    { id: "k", splitId: "split", personName: "Kiran", expectedAmountPaise: 1000 },
    { id: "r", splitId: "split", personName: "Ravi Teja", expectedAmountPaise: 27400 },
  ];
  expect(findPayments(fixtureView(model), { amount: "274", person: " KIRAN " }).candidates).toEqual([]);
  const ravi = findPayments(fixtureView(model), { amount: "274", person: " ravi TEJA " }).candidates;
  expect(ravi).toHaveLength(1);
  expect(ravi[0].reasons).toContain("exact share amount for Ravi Teja");
  expect(ravi[0].split_summary!.split_rev).toMatch(/^spr_/);
  expect(findPayments(fixtureView(model), { amount: "567", person: "Kiran" }).candidates[0].reasons).toContain("exact amount");
  expect(findPayments(fixtureView(model), { amount: "274" }).candidates[0].reasons).toContain("exact share amount for Ravi Teja");
});
