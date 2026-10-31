import { expect, test } from "bun:test";
import { Schema } from "effect";
import { validateTransactionUpdates, resolveCategoryName } from "./update-validation";
import { IdempotencyKey } from "./write-schemas";
import { scopeAllows } from "./token";
import { deriveMcpRevKey, transactionRev, deriveMcpRefKey, transactionRef } from "./refs";
const ref = transactionRef(deriveMcpRefKey("test"), "u", "t");
const row = { ref, rev: "rev-current", note: " lunch " };
const context = {
  transactions: new Map([[ref, { id: "t", rev: row.rev }]]),
  categories: [{ id: "food", name: "Food" }],
};
test("updates validate every refusal code, and one bad row discards all edits", () => {
  const cases = [
    { bad: { ...row, note: 3 }, code: "invalid_row" },
    { bad: { ...row, note: "x".repeat(1001) }, code: "invalid_row" },
    { bad: { ...row, ref: "missing" }, code: "unknown_ref" },
    { bad: row, code: "duplicate_ref" },
    { bad: { ...row, category: "food" }, code: "unknown_category" },
    { bad: { ...row, rev: "old" }, code: "stale" },
  ];
  for (const { bad, code } of cases) {
    const rows = code === "duplicate_ref" ? [row, bad] : [bad];
    const result = validateTransactionUpdates(rows, context);
    expect(result.edits).toEqual([]);
    expect(result.errors[0].code).toBe(code);
    if (code === "stale") expect(result.errors[0].current_rev).toBe(row.rev);
  }
  expect(validateTransactionUpdates([{ ref, rev: row.rev }], context).errors[0].code).toBe("no_fields");
  expect(validateTransactionUpdates([row, { ref: "bad", rev: "rev", note: null }], context).edits).toEqual(
    [],
  );
  expect(
    validateTransactionUpdates([{ ...row, category: "Food", transfer: true, needs_review: false }], context)
      .edits[0],
  ).toEqual({
    transactionId: "t",
    guard: { rev: row.rev },
    set: { categoryId: "food", note: row.note, isTransfer: true, needsReview: false },
  });
  expect(validateTransactionUpdates([{ ...row, category: null, note: null }], context).edits[0].set).toEqual({
    categoryId: null,
    note: null,
  });
});
test("revisions are stable and sensitive to every field, tenant, id and secret", () => {
  const key = deriveMcpRevKey("secret");
  const fields = { categoryId: null, note: "private@bank", isTransfer: false, needsReview: false };
  const rev = transactionRev(key, "u", "t", fields);
  expect(rev).toMatch(/^rev_[A-Za-z0-9_-]{12}$/);
  expect(transactionRev(key, "u", "t", fields)).toBe(rev);
  for (const set of [
    { categoryId: "food" },
    { note: null },
    { note: "private@bank " },
    { isTransfer: true },
    { needsReview: true },
  ])
    expect(transactionRev(key, "u", "t", { ...fields, ...set })).not.toBe(rev);
  expect(transactionRev(key, "other", "t", fields)).not.toBe(rev);
  expect(transactionRev(key, "u", "other", fields)).not.toBe(rev);
  expect(transactionRev(deriveMcpRevKey("other"), "u", "t", fields)).not.toBe(rev);
  expect(deriveMcpRefKey("secret")).not.toEqual(key);
  expect(() => deriveMcpRevKey(undefined)).toThrow();
});
test("scope nesting and idempotency key boundaries", () => {
  for (const scope of ["read", "propose", "write"] as const) {
    expect(scopeAllows(scope, "read")).toBe(true);
    expect(scopeAllows(scope, "propose")).toBe(scope !== "read");
    expect(scopeAllows(scope, "write")).toBe(scope === "write");
  }
  for (const key of ["12345678", "a".repeat(80), "retry_key-1"])
    expect(Schema.is(IdempotencyKey)(key)).toBe(true);
  for (const key of ["short", "a".repeat(81), "contains spaces", "has@symbol"])
    expect(Schema.is(IdempotencyKey)(key)).toBe(false);
});

test("write category names round-trip the redacted list exactly and refuse ambiguous names", () => {
  expect(resolveCategoryName([{ id: "one", name: "  Food   and dining " }], "Food and dining")).toBe("one");
  expect(resolveCategoryName([{ id: "one", name: "Food" }], "food")).toBeUndefined();
  expect(resolveCategoryName([{ id: "one", name: "private@bank" }], "private@bank")).toBeUndefined();
  expect(
    resolveCategoryName(
      [
        { id: "one", name: "Food" },
        { id: "two", name: " Food " },
      ],
      "Food",
    ),
  ).toBeUndefined();
});
