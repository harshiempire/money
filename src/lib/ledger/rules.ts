import { createHash } from "node:crypto";
import { Schema } from "effect";

export const Fields = Schema.Struct({
  categoryId: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  isTransfer: Schema.Boolean,
  needsReview: Schema.Boolean,
});
export type Fields = typeof Fields.Type;
export const DefaultFields = Schema.Struct({
  defaultCategoryId: Schema.NullOr(Schema.String),
});
const nullableText = Schema.NullOr(Schema.String);
const money = Schema.Number;
const createdAt = Schema.String;
const RowSchemas = {
  split: Schema.Struct({
    transactionId: Schema.String,
    totalPaise: money,
    yourSharePaise: money,
    note: nullableText,
    createdAt,
  }),
  participant: Schema.Struct({
    splitId: Schema.String,
    personId: nullableText,
    personName: Schema.String,
    expectedAmountPaise: money,
  }),
  person: Schema.Struct({
    userId: Schema.String,
    name: Schema.String,
    createdAt,
  }),
  settlement: Schema.Struct({
    inflowTransactionId: nullableText,
    splitParticipantId: nullableText,
    owedExpenseId: nullableText,
    netEventId: nullableText,
    amountPaise: money,
    method: Schema.Literals(["bank", "cash", "offset", "writeoff"]),
    note: nullableText,
    createdAt,
  }),
  net_event: Schema.Struct({
    userId: Schema.String,
    eventDate: Schema.String,
    inflowTransactionId: nullableText,
    outflowTransactionId: nullableText,
    note: nullableText,
    createdAt,
  }),
  owed_expense: Schema.Struct({
    userId: Schema.String,
    personId: nullableText,
    personName: Schema.String,
    incurredDate: Schema.String,
    amountPaise: money,
    description: Schema.String,
    categoryId: nullableText,
    note: nullableText,
    sourceInflowTransactionId: nullableText,
    createdAt,
  }),
  transaction_residual: Schema.Struct({
    residualDisposition: Schema.NullOr(Schema.Literals(["kept", "written_off"])),
    residualAcknowledgedPaise: Schema.NullOr(money),
  }),
};
// Dependents are part of the stale guard: a new settlement must prevent removing
// its share, even when the share's own columns have not changed.
function rowOperation<const T extends string, S extends Schema.Top>(target: T, row: S) {
  const state = Schema.NullOr(Schema.Struct({ row, dependents: Schema.Array(Schema.String) }));
  return Schema.Struct({
    target: Schema.Literal(target),
    id: Schema.String,
    before: state,
    after: state,
  });
}
export const RowOperation = Schema.Union([
  rowOperation("split", RowSchemas.split),
  rowOperation("participant", RowSchemas.participant),
  rowOperation("person", RowSchemas.person),
  rowOperation("settlement", RowSchemas.settlement),
  rowOperation("net_event", RowSchemas.net_event),
  rowOperation("owed_expense", RowSchemas.owed_expense),
  rowOperation("transaction_residual", RowSchemas.transaction_residual),
]);
export type RowOperation = typeof RowOperation.Type;
export const Operation = Schema.Union([
  RowOperation,
  Schema.Struct({
    target: Schema.Literal("counterparty_person"), id: Schema.String,
    before: Schema.Struct({ personId: nullableText }),
    after: Schema.Struct({ personId: nullableText }),
  }),
  Schema.Struct({
    target: Schema.Literal("counterparty_name"), id: Schema.String,
    before: Schema.Struct({ displayName: nullableText }),
    after: Schema.Struct({ displayName: nullableText }),
  }),
  Schema.Struct({
    target: Schema.Literal("standing_note"), id: Schema.String,
    before: Schema.NullOr(Schema.Struct({ userId: Schema.String, body: Schema.String, createdAt, updatedAt: createdAt })),
    after: Schema.NullOr(Schema.Struct({ userId: Schema.String, body: Schema.String, createdAt, updatedAt: createdAt })),
  }),
  Schema.Struct({
    target: Schema.Literal("transaction"),
    id: Schema.String,
    before: Fields,
    after: Fields,
  }),
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
export function sameFields(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
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

export function relationalSummary(kind: string, ops: readonly Operation[]): string {
  const split = ops.find((o) => o.target === "split");
  const people = [
    ...new Set(
      ops.flatMap((o) => {
        if (o.target !== "participant" && o.target !== "owed_expense") return [];
        const row = (o.after ?? o.before)?.row;
        return row ? [row.personName] : [];
      }),
    ),
  ];
  const names = people.length ? ` with ${people.join(", ")}` : "";
  if (kind === "create_split" && split?.target === "split")
    return `Split ₹${(((split.after ?? split.before)?.row.totalPaise ?? 0) / 100).toFixed(2)}${names}`;
  if (kind === "save_net_event") return `Net settlement${names}`;
  const labels: Record<string, string> = {
    undo: "Reversed ledger change",
    delete_split: "Deleted split",
    record_settlement: "Recorded bank settlement",
    clear_settlement: "Cleared bank settlement",
    record_cash_settlement: "Recorded cash settlement",
    delete_cash_settlement: "Deleted cash settlement",
    write_off_participant_share: "Forgave share",
    undo_write_off: "Reversed share writeoff",
    delete_net_event: "Deleted net settlement",
    create_owed_expense: "Added owed expense",
    update_owed_expense: "Updated owed expense",
    delete_owed_expense: "Deleted owed expense",
  };
  const amount = ops.reduce(
    (sum, op) => (op.target === "settlement" ? sum + (op.after?.row.amountPaise ?? 0) : sum),
    0,
  );
  return `${labels[kind] ?? kind.replaceAll("_", " ")}${amount ? ` ₹${(amount / 100).toFixed(2)}` : ""}${names}`;
}

export type Snapshot = Map<string, RowOperation>;
export function snapshotDiff(before: Snapshot, after: Snapshot): RowOperation[] {
  const ops: RowOperation[] = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const prev = before.get(id),
      next = after.get(id);
    const op = Schema.decodeUnknownSync(RowOperation)({
      ...(next ?? prev),
      before: prev?.after ?? null,
      after: next?.after ?? null,
    });
    // Existing people are shared labels: another use is not an edit to them.
    // A newly created/deleted person's dependents still guard its removal.
    if (op.target === "person" && op.before && op.after && sameFields(op.before.row, op.after.row)) continue;
    if (!sameFields(op.before, op.after)) ops.push(op);
  }
  return ops;
}

/** FK-safe order for applying the inverse, including undo of an undo. */
export function orderRowOperations(ops: readonly RowOperation[]) {
  const rank: Record<RowOperation["target"], number> = {
    person: 0,
    transaction_residual: 1,
    split: 2,
    owed_expense: 2,
    net_event: 2,
    participant: 3,
    settlement: 4,
  };
  return {
    deletes: ops
      .filter((op) => op.after === null)
      .sort((a, b) => rank[b.target] - rank[a.target] || a.id.localeCompare(b.id)),
    upserts: ops
      .filter((op) => op.after !== null)
      .sort((a, b) => rank[a.target] - rank[b.target] || a.id.localeCompare(b.id)),
  };
}
