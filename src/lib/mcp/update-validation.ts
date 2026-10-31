import { Result, Schema } from "effect";
import type { Edit } from "@/lib/ledger/transaction-fields";
import { modelSafeText } from "@/lib/assistant/model-view";
import { UpdateRow } from "./write-schemas";
export function resolveCategoryName(
  categories: readonly { id: string; name: string }[],
  name: string | null,
): string | null | undefined {
  if (name === null) return null;
  const matches = categories.filter((c) => modelSafeText(c.name, c.name.length) === name);
  return matches.length === 1 ? matches[0].id : undefined;
}
export type UpdateError = {
  index: number;
  ref: string | null;
  code: string;
  message: string;
  current_rev?: string;
};
export function validateTransactionUpdates(
  rows: readonly unknown[],
  context: {
    transactions: ReadonlyMap<string, { id: string; rev: string }>;
    categories: readonly { id: string; name: string }[];
  },
) {
  const edits: Edit[] = [],
    errors: UpdateError[] = [];
  const seen = new Set<string>();
  rows.forEach((raw, index) => {
    const parsed = Schema.decodeUnknownResult(UpdateRow)(raw);
    if (Result.isFailure(parsed)) {
      errors.push({
        index,
        ref: null,
        code: "invalid_row",
        message: "Use a ref, rev and valid editable fields.",
      });
      return;
    }
    const row = parsed.success;
    const fail = (code: string, message: string, current_rev?: string) =>
      errors.push({
        index,
        ref: /^txn_[A-Za-z0-9_-]{22}$/.test(row.ref) ? row.ref : null,
        code,
        message,
        ...(current_rev ? { current_rev } : {}),
      });
    if (seen.has(row.ref)) {
      fail("duplicate_ref", "Choose each ref once.");
      return;
    }
    seen.add(row.ref);
    const txn = context.transactions.get(row.ref);
    if (!txn) {
      fail("unknown_ref", "That ref isn't available in this account.");
      return;
    }
    if (
      row.category === undefined &&
      row.note === undefined &&
      row.transfer === undefined &&
      row.needs_review === undefined
    ) {
      fail("no_fields", "Provide a category, note, transfer or needs_review field.");
      return;
    }
    const categoryId =
      row.category === undefined ? undefined : resolveCategoryName(context.categories, row.category);
    if (row.category != null && categoryId === undefined) {
      fail("unknown_category", "Use an exact category name from list_categories.");
      return;
    }
    if (row.rev !== txn.rev) {
      fail("stale", "Read the transaction again before editing it.", txn.rev);
      return;
    }
    edits.push({
      transactionId: txn.id,
      guard: { rev: row.rev },
      set: {
        ...(row.category !== undefined ? { categoryId: categoryId ?? null } : {}),
        ...(row.note !== undefined ? { note: row.note } : {}),
        ...(row.transfer !== undefined ? { isTransfer: row.transfer } : {}),
        ...(row.needs_review !== undefined ? { needsReview: row.needs_review } : {}),
      },
    });
  });
  return { edits: errors.length ? [] : edits, errors };
}
