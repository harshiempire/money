import { Schema } from "effect";
const described = <S extends Schema.Top>(s: S, description: string) => s.annotate({ description });
export const IdempotencyKey = described(
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,80}$/u)),
  "Unique request key, 8–80 letters, digits, underscores or hyphens. Reuse only to retry the same request.",
);
export const UpdateRow = Schema.Struct({
  ref: described(Schema.String, "Opaque transaction ref from list_transactions."),
  rev: described(
    Schema.String,
    "The rev returned by list_transactions; required even when the note is hidden.",
  ),
  category: Schema.optionalKey(
    described(Schema.NullOr(Schema.String), "Exact category name from list_categories, or null to clear."),
  ),
  note: Schema.optionalKey(
    described(
      Schema.NullOr(Schema.String.check(Schema.isMaxLength(1000))),
      "Note of at most 1000 characters, or null to clear.",
    ),
  ),
  transfer: Schema.optionalKey(
    described(Schema.Boolean, "Explicit transfer flag, applied after the category's transfer rule."),
  ),
  needs_review: Schema.optionalKey(described(Schema.Boolean, "Whether the row needs review.")),
});
const DocumentedRow = Schema.Json.check(
  Schema.makeFilter(() => true, {
    toJsonSchema: () => Schema.toJsonSchemaDocument(UpdateRow).schema,
  }),
);
export const UpdateInput = Schema.Struct({
  rows: described(
    Schema.Array(DocumentedRow).check(Schema.isBetweenLength(1, 100)),
    "One to 100 edits; any bad row refuses the whole request.",
  ),
  reason: Schema.optionalKey(
    described(
      Schema.String.check(Schema.isMaxLength(200)),
      "Short reason for the change, at most 200 characters.",
    ),
  ),
  idempotency_key: IdempotencyKey,
});
export type UpdateInput = typeof UpdateInput.Type;
export const PayeeInput = Schema.Struct({
  ref: described(Schema.String, "Any transaction ref for this payee."),
  category: described(Schema.NullOr(Schema.String), "Exact category name, or null to clear the default."),
  current_default: described(
    Schema.NullOr(Schema.String),
    "Present default category name, or null if none. Confirms replacement.",
  ),
  idempotency_key: IdempotencyKey,
});
export type PayeeInput = typeof PayeeInput.Type;
export const ChangesInput = Schema.Struct({
  limit: Schema.optionalKey(
    described(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
      "Number of changes, up to 50; defaults to 20.",
    ),
  ),
  cursor: Schema.optionalKey(
    described(Schema.String.check(Schema.isMaxLength(512)), "Opaque next_cursor from the previous page."),
  ),
});
export const UndoInput = Schema.Struct({
  change_id: described(Schema.NonEmptyString, "Change id returned by list_changes or a write tool."),
  idempotency_key: IdempotencyKey,
});
export const WriteError = Schema.Struct({
  index: Schema.optionalKey(Schema.Int),
  ref: Schema.optionalKey(Schema.NullOr(Schema.String)),
  code: Schema.String,
  message: Schema.String,
  current_rev: Schema.optionalKey(Schema.String),
});
export const WriteOutput = Schema.Struct({
  applied: described(Schema.Boolean, "True only when the complete request succeeded."),
  change_id: Schema.optionalKey(
    described(Schema.NullOr(Schema.String), "Opaque change id for Undo; null for a no-op."),
  ),
  rows: Schema.optionalKey(
    described(
      Schema.Array(Schema.Struct({ ref: Schema.String, rev: Schema.String })),
      "Updated transaction refs and their new revisions.",
    ),
  ),
  errors: Schema.optionalKey(described(Schema.Array(WriteError), "Refusal codes; nothing was changed.")),
  replayed: Schema.optionalKey(
    described(Schema.Boolean, "This is the saved result of an earlier identical request."),
  ),
});
export const ChangesOutput = Schema.Struct({
  changes: Schema.Array(
    Schema.Struct({
      change_id: Schema.String,
      at: Schema.String,
      by: Schema.String,
      kind: Schema.String,
      summary: Schema.NullOr(Schema.String),
      rows: Schema.Int,
      undone: Schema.Boolean,
      undoes: Schema.optionalKey(Schema.String),
    }),
  ).annotate({ description: "Newest changes first. Text is always redacted." }),
  next_cursor: Schema.NullOr(Schema.String).annotate({ description: "Cursor for the next page, or null." }),
});
