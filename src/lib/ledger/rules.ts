import { createHash } from "node:crypto";
import { Schema } from "effect";
import { modelSafeText } from "@/lib/assistant/model-view";

export const Fields = Schema.Struct({
  categoryId: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  isTransfer: Schema.Boolean,
  needsReview: Schema.Boolean,
});
export type Fields = typeof Fields.Type;
export const DefaultFields = Schema.Struct({ defaultCategoryId: Schema.NullOr(Schema.String) });
export const Operation = Schema.Union([
  Schema.Struct({ target: Schema.Literal("transaction"), id: Schema.String, before: Fields, after: Fields }),
  Schema.Struct({
    target: Schema.Literal("counterparty"),
    id: Schema.String,
    before: DefaultFields,
    after: DefaultFields,
  }),
]);
export type Operation = typeof Operation.Type;
export const Operations = Schema.Array(Operation);
export const Guard = Schema.Struct({
  categoryId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  note: Schema.optionalKey(Schema.NullOr(Schema.String)),
  rev: Schema.optionalKey(Schema.String),
});
export type Guard = typeof Guard.Type;
export const SetFields = Schema.Struct({
  categoryId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  note: Schema.optionalKey(Schema.NullOr(Schema.String)),
  isTransfer: Schema.optionalKey(Schema.Boolean),
  needsReview: Schema.optionalKey(Schema.Boolean),
});
export type SetFields = typeof SetFields.Type;
export const cleanNote = (note: string | null) => note?.trim() || null;
/** Agents never see a note that fails modelSafeText, so they may not replace one or confirm a guess of it. */
export const noteHiddenFromAgent = (note: string | null) => note !== null && modelSafeText(note) === null;
export function guardMatches(before: Fields, guard?: Guard, rev?: string): boolean {
  return (
    !guard ||
    ((guard.categoryId === undefined || before.categoryId === (guard.categoryId || null)) &&
      (guard.note === undefined || cleanNote(before.note) === cleanNote(guard.note)) &&
      (guard.rev === undefined || guard.rev === rev))
  );
}
export function afterFields(before: Fields, set: SetFields, categoryKind?: string): Fields {
  return {
    ...before,
    ...(set.categoryId !== undefined
      ? {
          categoryId: set.categoryId || null,
          isTransfer: categoryKind === "transfer" || categoryKind === "investment",
        }
      : {}),
    ...(set.note !== undefined ? { note: cleanNote(set.note) } : {}),
    ...(set.isTransfer !== undefined ? { isTransfer: set.isTransfer } : {}),
    ...(set.needsReview !== undefined ? { needsReview: set.needsReview } : {}),
  };
}
export function sameFields(a: Operation["before"], b: Operation["before"]): boolean {
  const keys = Object.keys(a) as Array<keyof typeof a>;
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}
export function inverse(ops: readonly Operation[]): Operation[] {
  return ops.map((op) => ({ ...op, before: op.after, after: op.before }) as Operation);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function requestHash(tool: string, args: unknown): string {
  return createHash("sha256")
    .update(`${tool}:${canonical(args)}`)
    .digest("hex");
}
export function idempotencyDecision(existingHash: string | null | undefined, hash: string) {
  return existingHash == null ? "new" : existingHash === hash ? "replay" : "conflict";
}
