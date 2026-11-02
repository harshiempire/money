import { expect, test } from "bun:test";
import { reviewProposedRows } from "./draft-review";
import { rowPreselected, type TagFact } from "@/lib/assistant/tag-batch";
const fact: TagFact = {
  id: "txn-1",
  txnDate: "2026-10-01",
  amountPaise: 100,
  drCr: "debit",
  channel: "upi",
  categoryId: null,
  isTransfer: true,
  counterpartyId: "payee",
  displayName: "Lunch",
  parsedPurpose: null,
  label: "Lunch",
  note: null,
  bankRefId: "private",
  defaultCategoryId: null,
};
const row = {
  transactionId: "txn-1",
  categoryId: "food",
  expectedCurrentCategoryId: null,
  confidence: "high" as const,
  reason: "Lunch",
};
test("opening a draft skips changed, deleted and malformed rows and never preselects model guesses", () => {
  const review = reviewProposedRows(
    [
      row,
      {
        ...row,
        transactionId: "txn-2",
      },
      {
        ...row,
        transactionId: "gone",
      },
    ],
    [
      fact,
      {
        ...fact,
        id: "txn-2",
        categoryId: "already-set",
      },
    ],
    [
      {
        id: "food",
        name: "Food",
        kind: "spend",
      },
    ],
    "Claude",
    1,
  );
  expect(review.total).toBe(1);
  expect(review.changed).toBe(3);
  expect(review.rows).toEqual([
    {
      kind: "suggest",
      txnId: "txn-1",
      ref: "T1",
      suggestedCategoryId: "food",
      confidence: "high",
      reason: "Claude: Lunch",
      source: "model",
      choices: [],
      transfer: true,
      counterpartyId: "payee",
      defaultCategoryId: null,
    },
  ]);
  expect(rowPreselected(review.rows[0])).toBe(false);
});
