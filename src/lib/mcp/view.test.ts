import { expect, test } from "bun:test";
import { deriveMcpRefKey, transactionRef } from "./refs";
import { transactionView, rupees, type McpTransaction } from "./view";

const row: McpTransaction = {
  id: "private-db-id", txnDate: "2026-10-01", amountPaise: 123450, drCr: "debit", channel: "upi",
  displayName: "private.handle@bank", counterpartyKey: "private.handle@bank", counterpartyKind: "upi_handle",
  parsedPurpose: "Petr", label: "Bank label", rawDescription: "UPI/123456789/09:00/UPI/private.handle@bank/9876543210",
  note: "mail me@home 9876543210", category: "Food 12345", defaultCategory: "private@category",
  isTransfer: false, categoryId: "private-category-id", needsReview: false,
};

test("MCP returns full bank text, handles, purpose, notes and categories without database ids", () => {
  const view = transactionView(row, "opaque-ref", "rev-test");
  expect(view).toEqual({
    person: null, ref: "opaque-ref", rev: "rev-test", needs_review: false,
    date: "2026-10-01", amount: "1234.50", direction: "paid", channel: "upi",
    payee: row.displayName!, handle: row.counterpartyKey, raw_description: row.rawDescription,
    purpose: "Petr", note: row.note, category: row.category, payee_default: row.defaultCategory!, transfer: false,
  });
  for (const id of [row.id, row.categoryId!]) expect(JSON.stringify(view)).not.toContain(id);
  expect(transactionView({ ...row, person: "Kiran" }, "ref", "rev").person).toBe("Kiran");
  expect(rupees(-1)).toBe("-0.01");
  expect(rupees(9007199254740991)).toBe("90071992547409.91");
  expect(() => rupees(1.5)).toThrow();
});

test("payee fallback preserves display name, purpose, key and bank label in that order", () => {
  expect(transactionView({ ...row, displayName: null }, "ref", "rev").payee).toBe("Petr");
  const noPurpose = { ...row, displayName: null, parsedPurpose: null };
  expect(transactionView(noPurpose, "ref", "rev").payee).toBe("private.handle@bank");
  expect(transactionView({ ...noPurpose, counterpartyKey: null }, "ref", "rev").payee).toBe("Bank label");
  expect(transactionView({ ...row, counterpartyKind: "bank_name" }, "ref", "rev").handle).toBeNull();
  expect(transactionView({ ...row, note: null, category: null, defaultCategory: null, drCr: "credit" }, "ref", "rev")).toMatchObject({
    note: null, category: null, payee_default: null, direction: "received",
  });
});

test("refs are stable, user-bound and key-bound; configuration has no default", () => {
  const key = deriveMcpRefKey("test-secret");
  const ref = transactionRef(key, "alice", "hidden-db-id");
  expect(ref).toMatch(/^txn_[A-Za-z0-9_-]{22}$/);
  expect(transactionRef(key, "alice", "hidden-db-id")).toBe(ref);
  expect(transactionRef(key, "bob", "hidden-db-id")).not.toBe(ref);
  expect(transactionRef(deriveMcpRefKey("other-secret"), "alice", "hidden-db-id")).not.toBe(ref);
  expect(ref).not.toContain("hidden-db-id");
  expect(transactionRef(key, "alice", "another-db-id")).not.toBe(ref);
  expect(() => deriveMcpRefKey(undefined)).toThrow("not configured");
});
