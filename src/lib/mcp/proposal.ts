import { Predicate, Result, Schema } from "effect";
import { modelSafeText } from "@/lib/assistant/model-view";

const confidence = Schema.Literals(["high", "medium", "low"]);
export const ProposalRow = Schema.Struct({
  ref: Schema.NonEmptyString.annotate({ description: "Opaque transaction ref from list_transactions." }),
  category: Schema.NonEmptyString.annotate({ description: "Exact category name from list_categories." }),
  confidence: Schema.optionalKey(
    confidence.annotate({ description: "Suggested confidence: high, medium or low." }),
  ),
  reason: Schema.optionalKey(
    Schema.String.annotate({ description: "Short reason for the proposed category." }),
  ),
});
export const StoredTagRow = Schema.Struct({
  transactionId: Schema.NonEmptyString,
  categoryId: Schema.NonEmptyString,
  expectedCurrentCategoryId: Schema.Null,
  confidence,
  reason: Schema.NullOr(Schema.String),
});
export type StoredTagRow = typeof StoredTagRow.Type;
export const RejectionCode = Schema.Literals([
  "invalid_row",
  "unknown_ref",
  "duplicate_ref",
  "unknown_category",
  "already_categorized",
]);
export const ProposalRejection = Schema.Struct({
  index: Schema.Int,
  ref: Schema.NullOr(Schema.String),
  code: RejectionCode,
  message: Schema.String,
});
export type ProposalRejection = typeof ProposalRejection.Type;

export function validateTagProposal(
  rows: readonly unknown[],
  context: {
    transactions: ReadonlyMap<
      string,
      {
        id: string;
        categoryId: string | null;
      }
    >;
    categories: ReadonlyArray<{
      id: string;
      name: string;
    }>;
  },
): {
  accepted: StoredTagRow[];
  rejected: ProposalRejection[];
} {
  const accepted: StoredTagRow[] = [];
  const rejected: ProposalRejection[] = [];
  const seen = new Set<string>();
  rows.forEach((input, index) => {
    const decoded = Schema.decodeUnknownResult(ProposalRow)(input);
    const reject = (code: ProposalRejection["code"], message: string) => {
      const ref =
        Predicate.isObject(input) && Predicate.isString(input.ref) ? modelSafeText(input.ref, 80) : null;
      rejected.push({
        index,
        ref,
        code,
        message,
      });
    };
    if (Result.isFailure(decoded))
      return reject("invalid_row", "Each row needs a text ref, category and valid confidence.");
    const row = decoded.success;
    if (seen.has(row.ref)) return reject("duplicate_ref", "This ref already appeared in the batch.");
    const txn = context.transactions.get(row.ref);
    if (!txn) return reject("unknown_ref", "That ref isn't in this account.");
    const matches = context.categories.filter((c) => c.name.toLowerCase() === row.category.toLowerCase());
    if (matches.length !== 1)
      return reject("unknown_category", "Choose a category name from list_categories.");
    if (txn.categoryId !== null)
      return reject("already_categorized", "This transaction already has a category.");
    seen.add(row.ref);
    accepted.push({
      transactionId: txn.id,
      categoryId: matches[0].id,
      expectedCurrentCategoryId: null,
      confidence: row.confidence ?? "medium",
      reason: modelSafeText(row.reason, 80),
    });
  });
  return {
    accepted,
    rejected,
  };
}

export function decodeStoredTagRows(input: unknown): {
  rows: StoredTagRow[];
  malformed: number;
} {
  const list = Schema.decodeUnknownResult(Schema.Array(Schema.Unknown))(input);
  if (Result.isFailure(list))
    return {
      rows: [],
      malformed: 1,
    };
  const rows: StoredTagRow[] = [];
  let malformed = 0;
  for (const item of list.success) {
    const row = Schema.decodeUnknownResult(StoredTagRow)(item);
    if (Result.isFailure(row)) malformed++;
    else
      rows.push({
        ...row.success,
        reason: modelSafeText(row.success.reason, 80),
      });
  }
  return {
    rows,
    malformed,
  };
}
