/**
 * Apply and undo a tag draft one row at a time. A thrown row is recorded and
 * the rest continue, so one stale category cannot roll back the rows already
 * saved.
 */

/** One server call saves at most this many rows, so a timeout cannot sit on a 400-row write. */
export const TAG_APPLY_CHUNK = 50;

export function chunkApplyRows<T>(rows: T[], size = TAG_APPLY_CHUNK): T[][] {
  const out: T[][] = [];
  const step = Math.max(1, size);
  for (let i = 0; i < rows.length; i += step) out.push(rows.slice(i, i + step));
  return out;
}

export interface TagApplyRequest {
  transactionId: string;
  categoryId: string;
  expectedCurrentCategoryId: string | null;
}

export interface AppliedTag {
  transactionId: string;
  previousCategoryId: string | null;
  categoryId: string;
  /** The flag on the row before this apply. Undo writes it back. */
  previousIsTransfer: boolean;
}

export interface TagApplyResult {
  applied: AppliedTag[];
  failed: Array<{ transactionId: string; reason: string }>;
  skipped: number;
}

export async function runTagApply(
  rows: TagApplyRequest[],
  applyOne: (row: TagApplyRequest) => Promise<{ previousIsTransfer: boolean }>,
): Promise<TagApplyResult> {
  const applied: AppliedTag[] = [];
  const failed: TagApplyResult["failed"] = [];
  let skipped = 0;
  for (const row of rows) {
    if (!row.categoryId) {
      skipped++;
      continue;
    }
    try {
      const written = await applyOne(row);
      applied.push({
        transactionId: row.transactionId,
        previousCategoryId: row.expectedCurrentCategoryId,
        categoryId: row.categoryId,
        previousIsTransfer: written.previousIsTransfer,
      });
    } catch (err) {
      failed.push({
        transactionId: row.transactionId,
        reason: err instanceof Error && err.message ? err.message : "Couldn't update this row.",
      });
    }
  }
  return { applied, failed, skipped };
}

export interface TagUndoResult {
  restored: AppliedTag[];
  failed: Array<{ transactionId: string; reason: string }>;
}

export async function runTagUndo(
  applied: AppliedTag[],
  restoreOne: (row: AppliedTag) => Promise<void>,
): Promise<TagUndoResult> {
  const restored: AppliedTag[] = [];
  const failed: TagUndoResult["failed"] = [];
  for (const row of applied) {
    try {
      await restoreOne(row);
      restored.push(row);
    } catch (err) {
      failed.push({
        transactionId: row.transactionId,
        reason: err instanceof Error && err.message ? err.message : "Couldn't undo this row.",
      });
    }
  }
  return { restored, failed };
}
