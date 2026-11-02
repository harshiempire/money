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
const before: Fields = {
  categoryId: null,
  note: " lunch ",
  isTransfer: false,
  needsReview: false,
};
test("guards compare category, trimmed notes and complete-field revisions", () => {
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
    {
      target: "transaction",
      id: "t",
      before,
      after: { ...before, note: "after" },
    },
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
  const hash = requestHash("update", {
    z: [{ note: "lunch", transfer: false }],
    a: 1,
  });
  expect(requestHash("update", { a: 1, z: [{ transfer: false, note: "lunch" }] })).toBe(hash);
  expect(requestHash("undo", { a: 1, z: [{ transfer: false, note: "lunch" }] })).not.toBe(hash);
  expect(requestHash("update", { a: 1, z: [{ transfer: true, note: "lunch" }] })).not.toBe(hash);
  expect(requestHash("update", { a: null })).not.toBe(requestHash("update", {}));
  expect(requestHash("update", [1, 2])).not.toBe(requestHash("update", [2, 1]));
  expect(idempotencyDecision(null, hash)).toBe("new");
  expect(idempotencyDecision(hash, hash)).toBe("replay");
  expect(idempotencyDecision("other", hash)).toBe("conflict");
});

test("full notes with handles and long numbers use ordinary edit, stale and undo rules", () => {
  const note = "paid ravi@bank 9876543210";
  const after = afterFields(before, { note });
  expect(after.note).toBe(note);
  expect(guardMatches(after, { note, rev: "current" }, "current")).toBe(true);
  expect(guardMatches(after, { rev: "old" }, "current")).toBe(false);
  const [undo] = inverse([{ target: "transaction", id: "t", before, after }]);
  expect(undo.before).toEqual(after);
  expect(undo.after).toEqual(before);
});

import { Schema } from "effect";
import {
  Operations,
  RowOperation,
  snapshotDiff,
  relationalSummary,
  orderRowOperations,
  type Snapshot,
} from "./rules";
const at = "2026-10-01 12:00:00.123456+00";
const rows = {
  split: {
    transactionId: "t",
    totalPaise: 56700,
    yourSharePaise: 29300,
    note: null,
    createdAt: at,
  },
  participant: {
    splitId: "split",
    personId: "person",
    personName: "Kiran",
    expectedAmountPaise: 27400,
  },
  person: { userId: "u", name: "Kiran", createdAt: at },
  settlement: {
    inflowTransactionId: "inflow",
    splitParticipantId: "participant",
    owedExpenseId: null,
    netEventId: null,
    amountPaise: 10100,
    method: "bank",
    note: null,
    createdAt: at,
  },
  net_event: {
    userId: "u",
    eventDate: "2026-10-01",
    inflowTransactionId: "inflow",
    outflowTransactionId: null,
    note: null,
    createdAt: at,
  },
  owed_expense: {
    userId: "u",
    personId: "person",
    personName: "Kiran",
    incurredDate: "2026-10-01",
    amountPaise: 100,
    description: "Lunch",
    categoryId: null,
    note: null,
    sourceInflowTransactionId: null,
    createdAt: at,
  },
  transaction_residual: {
    residualDisposition: "kept",
    residualAcknowledgedPaise: 123,
  },
};
function rowOp(target: keyof typeof rows, before: boolean, after: boolean): RowOperation {
  const state = { row: rows[target], dependents: [] };
  return Schema.decodeUnknownSync(RowOperation)({
    target,
    id: target,
    before: before ? state : null,
    after: after ? state : null,
  });
}
test("all relational schemas preserve ids, nullable states, exact timestamps and inverse of inverse", () => {
  for (const target of Object.keys(rows) as Array<keyof typeof rows>) {
    for (const [before, after] of [
      [false, true],
      [true, false],
      [true, true],
    ]) {
      const op = rowOp(target, before, after);
      expect(Schema.decodeUnknownSync(Operations)(JSON.parse(JSON.stringify([op])))).toEqual([op]);
      expect(inverse(inverse([op]))).toEqual([op]);
      expect(inverse([op])[0].after).toEqual(op.before);
      expect(Schema.is(RowOperation)({ ...op, after: { row: {}, dependents: [] } })).toBe(false);
    }
  }
  expect(
    Schema.is(RowOperation)({
      target: "settlement",
      id: "x",
      before: null,
      after: {
        row: { ...rows.settlement, method: "invented" },
        dependents: [],
      },
    }),
  ).toBe(false);
  expect(
    Schema.is(RowOperation)({
      target: "transaction_residual",
      id: "x",
      before: null,
      after: {
        row: { ...rows.transaction_residual, residualDisposition: "owed_back" },
        dependents: [],
      },
    }),
  ).toBe(false);
});
test("old field operations and new row operations decode in the same stored change", () => {
  const old: Operation = {
    target: "transaction",
    id: "t",
    before,
    after: before,
  };
  expect(Schema.decodeUnknownSync(Operations)([old, rowOp("split", false, true)])).toHaveLength(2);
  expect(
    Schema.decodeUnknownSync(Operations)([
      {
        target: "counterparty",
        id: "p",
        before: { defaultCategoryId: null },
        after: { defaultCategoryId: "food" },
      },
    ]),
  ).toHaveLength(1);
});
test("diff captures cascades, parent guards and residuals but does not edit an existing person label", () => {
  const person = rowOp("person", true, true);
  const share = rowOp("participant", true, true);
  const settlement = rowOp("settlement", true, true);
  const before: Snapshot = new Map([
    ["person:person", person],
    ["participant:participant", share],
    ["settlement:settlement", settlement],
  ]);
  const after: Snapshot = new Map(before);
  const nextShare = Schema.decodeUnknownSync(RowOperation)({
    ...share,
    after: { row: rows.participant, dependents: ["settlement:new"] },
  });
  after.set("participant:participant", nextShare);
  after.delete("settlement:settlement");
  after.set(
    "person:person",
    Schema.decodeUnknownSync(RowOperation)({
      ...person,
      after: { row: rows.person, dependents: ["participant:another"] },
    }),
  );
  const diff = snapshotDiff(before, after);
  expect(diff.map((o) => o.target)).toEqual(["participant", "settlement"]);
  expect(diff.find((o) => o.target === "settlement")?.after).toBeNull();
  expect(sameFields(share.after, nextShare.after)).toBe(false);
  const reversed: readonly Operation[] = snapshotDiff(after, before);
  expect(reversed).toEqual(inverse(diff));
});
test("readable summaries name the split, settlement amount and affected people", () => {
  const ops = [rowOp("split", false, true), rowOp("participant", false, true)];
  expect(relationalSummary("create_split", ops)).toBe("Split ₹567.00 with Kiran");
  expect(relationalSummary("save_net_event", ops)).toBe("Net settlement with Kiran");
  expect(relationalSummary("record_settlement", [...ops, rowOp("settlement", false, true)])).toBe(
    "Recorded bank settlement ₹101.00 with Kiran",
  );
  expect(relationalSummary("delete_owed_expense", [rowOp("owed_expense", true, false)])).toBe(
    "Deleted owed expense with Kiran",
  );
});

test("inverse persistence deletes children first and restores parents before children", () => {
  const targets = ["settlement", "split", "person", "participant", "owed_expense", "net_event"] as const;
  const ops = targets.map((target) => rowOp(target, true, false));
  expect(orderRowOperations(ops).deletes.map((op) => op.target)).toEqual([
    "settlement",
    "participant",
    "net_event",
    "owed_expense",
    "split",
    "person",
  ]);
  const reversed = inverse(ops).map((op) => Schema.decodeUnknownSync(RowOperation)(op));
  expect(orderRowOperations(reversed).upserts.map((op) => op.target)).toEqual([
    "person",
    "net_event",
    "owed_expense",
    "split",
    "participant",
    "settlement",
  ]);
});
