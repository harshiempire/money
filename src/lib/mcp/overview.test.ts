import { expect, test } from "bun:test";
import { Schema } from "effect";
import { buildOverview } from "./overview";
import { OverviewOutput } from "./schemas";

test("overview sorts months, sums exact bank totals, counts null categories and groups open balances", () => {
  const overview = buildOverview([
    { txnDate: "2026-10-31", amountPaise: 56700, drCr: "debit", categoryId: null, hasSplit: true },
    { txnDate: "2026-09-01", amountPaise: 1234, drCr: "credit", categoryId: null, hasSplit: false },
    { txnDate: "2026-10-01", amountPaise: 300, drCr: "debit", categoryId: "transfer", hasSplit: false },
    { txnDate: "2026-10-02", amountPaise: 100, drCr: "credit", categoryId: null, hasSplit: true },
  ], [
    { txnDate: "2026-10-31", personName: "Kiran", outstandingPaise: 27400 },
    { txnDate: "2026-10-02", personName: " kiran ", outstandingPaise: 1 },
    { txnDate: "2026-09-01", personName: "Settled", outstandingPaise: 0 },
    { txnDate: "2026-09-01", personName: "Overpaid", outstandingPaise: -100 },
  ], [
    { personName: "KIRAN", outstandingPaise: 500 },
    { personName: "Owner owes", outstandingPaise: 30000 },
    { personName: "Paid back", outstandingPaise: 0 },
  ]);
  expect(Schema.is(OverviewOutput)(overview)).toBe(true);
  expect(overview).toEqual({
    first_transaction_date: "2026-09-01", last_transaction_date: "2026-10-31",
    months: [
      { month: "2026-09", rows: 1, paid: "0.00", received: "12.34", uncategorized: 1, split_count: 0, open_shares: "0.00" },
      { month: "2026-10", rows: 3, paid: "570.00", received: "1.00", uncategorized: 2, split_count: 2, open_shares: "274.01" },
    ],
    totals: { rows: 4, paid: "570.00", received: "13.34", uncategorized: 3, split_count: 2, open_shares: "274.01" },
    people: [
      { name: "Owner owes", owed_to_you: "0.00", you_owe: "300.00" },
      { name: "Kiran", owed_to_you: "274.01", you_owe: "5.00" },
    ],
  });
});

test("empty overview has null dates and no people/months, while user payables can exist without bank rows", () => {
  expect(buildOverview([], [], [])).toEqual({
    first_transaction_date: null, last_transaction_date: null, months: [], people: [],
    totals: { rows: 0, paid: "0.00", received: "0.00", uncategorized: 0, split_count: 0, open_shares: "0.00" },
  });
  expect(buildOverview([], [], [{ personName: "Ravi", outstandingPaise: 1 }]).people).toEqual([
    { name: "Ravi", owed_to_you: "0.00", you_owe: "0.01" },
  ]);
});
