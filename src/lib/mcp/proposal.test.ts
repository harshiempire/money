import { expect, test } from "bun:test";
import { validateTagProposal, decodeStoredTagRows } from "./proposal";
const context = {
  transactions: new Map([
    [
      "txn_good",
      {
        id: "db-1",
        categoryId: null,
      },
    ],
    [
      "txn_unsafe",
      {
        id: "db-2",
        categoryId: null,
      },
    ],
    [
      "txn_done",
      {
        id: "db-3",
        categoryId: "cat-old",
      },
    ],
  ]),
  categories: [
    {
      id: "cat-food",
      name: "Food",
    },
  ],
};
test("a rejected row does not reserve its ref against a later valid row", () => {
  const result = validateTagProposal(
    [
      {
        ref: "txn_good",
        category: "Nonexistent",
      },
      {
        ref: "txn_good",
        category: "Food",
      },
    ],
    context,
  );
  expect(result.accepted).toHaveLength(1);
  expect(result.accepted[0].transactionId).toBe("db-1");
  expect(result.rejected.map((row) => [row.index, row.code])).toEqual([[0, "unknown_category"]]);
});
test("an accepted row reserves its ref against a later valid row", () => {
  const result = validateTagProposal(
    [
      {
        ref: "txn_good",
        category: "Food",
      },
      {
        ref: "txn_good",
        category: "Food",
      },
    ],
    context,
  );
  expect(result.accepted).toHaveLength(1);
  expect(result.rejected.map((row) => [row.index, row.code])).toEqual([[1, "duplicate_ref"]]);
});
test("mixed proposals preserve good rows and reject each bad row independently", () => {
  const result = validateTagProposal(
    [
      {
        ref: "txn_good",
        category: "fOoD",
        confidence: "high",
        reason: "Lunch",
      },
      {
        ref: 123,
        category: "Food",
      },
      { ref: "txn_missing" },
      {
        ref: "txn_absent",
        category: "Food",
      },
      {
        ref: "txn_good",
        category: "Food",
      },
      {
        ref: "txn_unknowncat",
        category: "Other",
      },
      {
        ref: "txn_done",
        category: "Food",
      },
      {
        ref: "txn_unsafe",
        category: "Food",
        reason: "name@bank 9876543210",
      },
    ],
    {
      ...context,
      transactions: new Map([
        ...context.transactions,
        [
          "txn_unknowncat",
          {
            id: "db-4",
            categoryId: null,
          },
        ],
      ]),
    },
  );
  expect(result.accepted).toEqual([
    {
      transactionId: "db-1",
      categoryId: "cat-food",
      expectedCurrentCategoryId: null,
      confidence: "high",
      reason: "Lunch",
    },
    {
      transactionId: "db-2",
      categoryId: "cat-food",
      expectedCurrentCategoryId: null,
      confidence: "medium",
      reason: null,
    },
  ]);
  expect(result.rejected.map((r) => [r.index, r.code])).toEqual([
    [1, "invalid_row"],
    [2, "invalid_row"],
    [3, "unknown_ref"],
    [4, "duplicate_ref"],
    [5, "unknown_category"],
    [6, "already_categorized"],
  ]);
  expect(result.rejected[0].ref).toBeNull();
});
test("all bad produces no accepted rows; stored JSON is decoded row by row", () => {
  expect(validateTagProposal([null, { ref: 1 }], context).accepted).toEqual([]);
  expect(
    decodeStoredTagRows([
      null,
      {
        transactionId: "db-1",
        categoryId: "cat-food",
        expectedCurrentCategoryId: null,
        confidence: "medium",
        reason: null,
      },
    ]),
  ).toEqual({
    rows: [
      {
        transactionId: "db-1",
        categoryId: "cat-food",
        expectedCurrentCategoryId: null,
        confidence: "medium",
        reason: null,
      },
    ],
    malformed: 1,
  });
  expect(decodeStoredTagRows({ corrupt: true })).toEqual({
    rows: [],
    malformed: 1,
  });
});
