import { expect, test } from "bun:test";
import { pageTransactions } from "./pagination";
import { deriveMcpRefKey } from "./refs";
import type { McpTransaction } from "./view";
const actor = {
  userId: "alice",
  accountId: "a",
};
const key = deriveMcpRefKey("page-test");
const base: McpTransaction = {
  id: "db-1",
  txnDate: "2026-10-01",
  amountPaise: 101,
  drCr: "debit",
  channel: "upi",
  displayName: "Lunch",
  parsedPurpose: null,
  label: "Payee",
  counterpartyKey: "private@bank", counterpartyKind: "upi_handle", rawDescription: "UPI 123456789",
  note: null,
  category: null,
  categoryId: null, needsReview: false,
  isTransfer: false,
};
const rows = [
  base,
  {
    ...base,
    id: "db-2",
  },
  {
    ...base,
    id: "db-3",
    txnDate: "2026-09-01",
  },
];
test("transaction pages use stable date/id order and opaque cursors", () => {
  const first = pageTransactions(rows, { limit: 1 }, actor, key);
  expect(first.transactions[0].amount).toBe("1.01");
  expect(first.next_cursor).toBeString();
  expect(Buffer.from(first.next_cursor!, "base64url").toString()).not.toContain("db-");
  const second = pageTransactions(
    rows,
    {
      limit: 1,
      cursor: first.next_cursor!,
    },
    actor,
    key,
  );
  expect(second.transactions[0].ref).not.toBe(first.transactions[0].ref);
  const third = pageTransactions(
    rows,
    {
      limit: 1,
      cursor: second.next_cursor!,
    },
    actor,
    key,
  );
  expect(third.transactions[0].date).toBe("2026-09-01");
  expect(third.next_cursor).toBeNull();
  expect(pageTransactions(rows, { month: "2026-10" }, actor, key).transactions).toHaveLength(2);
  expect(() => pageTransactions(rows, { cursor: "not-json" }, actor, key)).toThrow("cursor");
  expect(() =>
    pageTransactions(
      rows,
      { cursor: first.next_cursor! },
      {
        ...actor,
        userId: "bob",
      },
      key,
    ),
  ).toThrow("cursor");
});
test("payee matching searches full handles and raw descriptions even with a different display name", () => {
  for (const payee of ["PRIVATE@BANK", "123456789", "LUNCH"])
    expect(pageTransactions(rows, { payee }, actor, key).transactions).toHaveLength(3);
  expect(pageTransactions(rows, { payee: "absent" }, actor, key).transactions).toEqual([]);
});

test("inclusive date bounds, direction and exact category filters compose", () => {
  const data = [
    ...rows,
    { ...base, id: "end", txnDate: "2026-10-31", drCr: "credit" as const, category: "Food", categoryId: "food" },
    { ...base, id: "outside", txnDate: "2026-11-01" },
  ];
  expect(pageTransactions(data, { from: "2026-10-01", to: "2026-10-31" }, actor, key).transactions).toHaveLength(3);
  expect(pageTransactions(data, { month: "2026-10", direction: "received", category: "Food" }, actor, key).transactions).toHaveLength(1);
  expect(pageTransactions(data, { category: "food" }, actor, key).transactions).toHaveLength(0);
  expect(pageTransactions(data, { from: "2026-10-31" }, actor, key).transactions).toHaveLength(2);
  expect(pageTransactions(data, { to: "2026-09-01" }, actor, key).transactions).toHaveLength(1);
});

test("uncategorized includes credits and transfers, using category id rather than a missing joined name", () => {
  const data = [
    base,
    { ...base, id: "credit", drCr: "credit" as const },
    { ...base, id: "transfer", isTransfer: true },
    { ...base, id: "categorized", categoryId: "foreign-or-missing-category-name", category: null },
  ];
  expect(pageTransactions(data, { uncategorized: true }, actor, key).transactions).toHaveLength(3);
});
