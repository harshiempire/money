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
  note: null,
  category: null,
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
test("payee matching never searches bank labels hidden by the safe display name", () => {
  expect(
    pageTransactions(
      [
        {
          ...base,
          label: "secret@bank",
        },
      ],
      { payee: "secret" },
      actor,
      key,
    ).transactions,
  ).toEqual([]);
  expect(pageTransactions(rows, { payee: "LUNCH" }, actor, key).transactions).toHaveLength(3);
  expect(() => pageTransactions(rows, { payee: "12345" }, actor, key)).toThrow("five");
});
