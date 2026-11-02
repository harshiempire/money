import { expect, test } from "bun:test";
import { chunkApplyRows, runTagApply, runTagUndo, TAG_APPLY_CHUNK, type AppliedTag, type TagApplyRequest } from "./tag-apply";

const stale = new Error("The category changed since this card was made. Ask again to get a fresh card.");

test("one stale row does not drop the rest of the batch", async () => {
  const rows: TagApplyRequest[] = [
    { transactionId: "a", categoryId: "food", expectedCurrentCategoryId: null },
    { transactionId: "b", categoryId: "travel", expectedCurrentCategoryId: null },
    { transactionId: "c", categoryId: "", expectedCurrentCategoryId: null },
    { transactionId: "d", categoryId: "subs", expectedCurrentCategoryId: null },
  ];
  const saved: string[] = [];
  const result = await runTagApply(rows, async (row) => {
    if (row.transactionId === "b") throw stale;
    saved.push(row.transactionId);
    return { previousIsTransfer: false };
  });
  expect(saved).toEqual(["a", "d"]);
  expect(result.applied.map((r) => r.transactionId)).toEqual(["a", "d"]);
  expect(result.applied[0]).toEqual({
    transactionId: "a",
    previousCategoryId: null,
    categoryId: "food",
    previousIsTransfer: false,
  });
  expect(result.failed).toEqual([{ transactionId: "b", reason: stale.message }]);
  expect(result.skipped).toBe(1);
});

test("undo restores each applied row and leaves a row that changed since", async () => {
  const applied: AppliedTag[] = [
    { transactionId: "a", previousCategoryId: null, categoryId: "food", previousIsTransfer: false },
    { transactionId: "b", previousCategoryId: "old", categoryId: "travel", previousIsTransfer: false },
  ];
  const restored: Array<{ id: string; categoryId: string; expected: string }> = [];
  const result = await runTagUndo(applied, async (row) => {
    if (row.transactionId === "b") throw stale;
    restored.push({
      id: row.transactionId,
      categoryId: row.previousCategoryId ?? "",
      expected: row.categoryId,
    });
  });
  expect(restored).toEqual([{ id: "a", categoryId: "", expected: "food" }]);
  expect(result.restored.map((r) => r.transactionId)).toEqual(["a"]);
  expect(result.failed.map((r) => r.transactionId)).toEqual(["b"]);
});

test("undo writes back the transfer flag that apply replaced", async () => {
  let flag = true;
  const result = await runTagApply(
    [{ transactionId: "xfer", categoryId: "food", expectedCurrentCategoryId: null }],
    async () => {
      const previousIsTransfer = flag;
      flag = false;
      return { previousIsTransfer };
    },
  );
  expect(flag).toBe(false);
  expect(result.applied[0]?.previousIsTransfer).toBe(true);
  await runTagUndo(result.applied, async (row) => {
    flag = row.previousIsTransfer;
  });
  expect(flag).toBe(true);
});

test("apply chunks stay at 50 rows", () => {
  const chunks = chunkApplyRows(Array.from({ length: 120 }, (_, i) => i));
  expect(TAG_APPLY_CHUNK).toBe(50);
  expect(chunks.map((chunk) => chunk.length)).toEqual([50, 50, 20]);
});
