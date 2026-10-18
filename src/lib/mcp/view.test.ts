import { expect, test } from "bun:test";
import { deriveMcpRefKey, transactionRef } from "./refs";
import { transactionView, validatePayeeFilter, rupees, bankPayeeLabel } from "./view";
import { userChosenDisplayName } from "@/lib/assistant/model-view";
import type { McpTransaction } from "./view";

test("transaction views omit bank text, handles, digits and unsafe notes", () => {
  const rawDescription = "UPI/123456789/09:00/UPI/private.handle@bank/9876543210";
  const view = transactionView(
    {
      id: "private-db-id",
      txnDate: "2026-10-01",
      amountPaise: 123450,
      drCr: "debit",
      channel: "upi",
      displayName: "private.handle@bank",
      parsedPurpose: "Lunch",
      label: bankPayeeLabel(rawDescription),
      note: "mail me@home",
      category: "Food",
      isTransfer: false,
    },
    "opaque-ref",
  );
  expect(view).toEqual({
    ref: "opaque-ref",
    date: "2026-10-01",
    amount: "1234.50",
    direction: "paid",
    channel: "upi",
    payee: "Lunch",
    note: null,
    category: "Food",
    transfer: false,
  });
  const json = JSON.stringify(view);
  for (const secret of [
    "private",
    "handle",
    "bank",
    "9876543210",
    "123456789",
    "private-db-id",
    rawDescription,
  ])
    expect(json).not.toContain(secret);
  expect(rupees(-1)).toBe("-0.01");
  expect(rupees(9007199254740991)).toBe("90071992547409.91");
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
test("payee filters refuse the same unsafe text the view omits", () => {
  expect(validatePayeeFilter("lunch")).toBe("lunch");
  expect(() => validatePayeeFilter("name@bank")).toThrow();
  expect(() => validatePayeeFilter("12345")).toThrow();
});

test("bank label extraction never exposes a fragment of a wrapped UPI handle", () => {
  const raw = "UPI/123456789/09:00/UPI/private.handle- 1@okaxis";
  const view = transactionView(
    {
      id: "db",
      txnDate: "2026-10-01",
      amountPaise: 100,
      drCr: "debit",
      channel: "upi",
      displayName: null,
      parsedPurpose: null,
      label: bankPayeeLabel(raw),
      note: null,
      category: null,
      isTransfer: false,
    },
    "ref",
  );
  expect(view.payee).toBe("Payee");
  expect(JSON.stringify(view)).not.toContain("private.handle");
  expect(bankPayeeLabel("NEFT-ABCD123-JANE DOE")).toBe("JANE DOE");
  expect(bankPayeeLabel("ordinary bank description")).toBe("Payee");
});

test("MCP payees omit handle-shaped display names and purposes, preserving normal names", () => {
  const row: McpTransaction = {
    id: "db", txnDate: "2026-10-01", amountPaise: 100, drCr: "debit", channel: "upi",
    displayName: null, parsedPurpose: null, label: "Payee", note: null, category: null, isTransfer: false,
  };
  for (const handle of ["paytm.s2wy2f", "rohanrao.b-", "q123456", "ravi_k"]) {
    expect(transactionView({ ...row, displayName: handle, parsedPurpose: "lunch" }, "ref").payee).toBe("lunch");
    expect(transactionView({ ...row, displayName: handle, parsedPurpose: handle }, "ref").payee).toBe("Payee");
  }
  for (const name of ["Swiggy", "Padmavathi Tiffins", "ACME PAYROLL", "groceries", "lunch", "Petrol"]) {
    expect(transactionView({ ...row, displayName: name }, "ref").payee).toBe(name);
    expect(transactionView({ ...row, parsedPurpose: name }, "ref").payee).toBe(name);
  }
  // Alphabetic auto names evade the handle-shape check: loader provenance must reject them.
  expect(transactionView({
    ...row,
    displayName: userChosenDisplayName({ kind: "upi_handle", key: "ravi", displayName: " RA VI " }),
  }, "ref").payee).toBe("Payee");
  expect(transactionView({
    ...row,
    displayName: userChosenDisplayName({ kind: "upi_handle", key: "ravi_k", displayName: "Ravi Kumar" }),
  }, "ref").payee).toBe("Ravi Kumar");
});
