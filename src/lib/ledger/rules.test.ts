import { expect, test } from "bun:test";
import {
  afterFields,
  guardMatches,
  inverse,
  sameFields,
  requestHash,
  idempotencyDecision,
  type Fields,
  type Operation,
} from "./rules";
const before: Fields = { categoryId: null, note: " lunch ", isTransfer: false, needsReview: false };
test("guards compare category, trimmed notes and hidden-field revisions", () => {
  expect(guardMatches(before)).toBe(true);
  expect(guardMatches(before, { categoryId: null, note: "lunch", rev: "rev-a" }, "rev-a")).toBe(true);
  expect(guardMatches(before, { categoryId: "food" })).toBe(false);
  expect(guardMatches(before, { note: null })).toBe(false);
  expect(guardMatches(before, { rev: "old" }, "current")).toBe(false);
  expect(guardMatches({ ...before, note: null }, { note: " " })).toBe(true);
});
test("category controls transfer first, explicit flag overrides, notes trim", () => {
  expect(afterFields(before, { categoryId: "invest", note: "  " }, "investment")).toEqual({
    ...before,
    categoryId: "invest",
    note: null,
    isTransfer: true,
  });
  expect(afterFields(before, { categoryId: "transfer" }, "transfer").isTransfer).toBe(true);
  expect(afterFields(before, { categoryId: "transfer", isTransfer: false }, "transfer").isTransfer).toBe(
    false,
  );
  expect(afterFields({ ...before, isTransfer: true }, { categoryId: null }).isTransfer).toBe(false);
  expect(afterFields(before, { note: " dinner ", needsReview: true })).toEqual({
    ...before,
    note: "dinner",
    needsReview: true,
  });
});
test("diffs distinguish null and empty, inverse handles both target types and undo of undo", () => {
  expect(sameFields(before, { ...before })).toBe(true);
  for (const set of [{ categoryId: "food" }, { note: "" }, { isTransfer: true }, { needsReview: true }])
    expect(sameFields(before, { ...before, ...set })).toBe(false);
  const ops: Operation[] = [
    { target: "transaction", id: "t", before, after: { ...before, note: "after" } },
    {
      target: "counterparty",
      id: "p",
      before: { defaultCategoryId: null },
      after: { defaultCategoryId: "food" },
    },
  ];
  expect(inverse(inverse(ops))).toEqual(ops);
  expect(inverse(ops)[0].after).toEqual(before);
});
test("idempotency canonicalizes key order while binding tool, values, nulls and array order", () => {
  const hash = requestHash("update", { z: [{ note: "lunch", transfer: false }], a: 1 });
  expect(requestHash("update", { a: 1, z: [{ transfer: false, note: "lunch" }] })).toBe(hash);
  expect(requestHash("undo", { a: 1, z: [{ transfer: false, note: "lunch" }] })).not.toBe(hash);
  expect(requestHash("update", { a: 1, z: [{ transfer: true, note: "lunch" }] })).not.toBe(hash);
  expect(requestHash("update", { a: null })).not.toBe(requestHash("update", {}));
  expect(requestHash("update", [1, 2])).not.toBe(requestHash("update", [2, 1]));
  expect(idempotencyDecision(null, hash)).toBe("new");
  expect(idempotencyDecision(hash, hash)).toBe("replay");
  expect(idempotencyDecision("other", hash)).toBe("conflict");
});
