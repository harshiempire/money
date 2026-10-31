import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Schema } from "effect";
import { db, schema } from "@/db";
import { deriveMcpRevKey, transactionRev } from "@/lib/mcp/refs";
import type { WriteContext } from "./context";
import { LedgerError } from "./context";
import {
  afterFields,
  Fields,
  Guard,
  guardMatches,
  noteHiddenFromAgent,
  sameFields,
  SetFields,
  type Operation,
} from "./rules";
import { runChange } from "./store";
export const Edit = Schema.Struct({
  transactionId: Schema.NonEmptyString,
  set: SetFields,
  guard: Schema.optionalKey(Guard),
});
export type Edit = typeof Edit.Type;
const Input = Schema.Struct({
  edits: Schema.Array(Edit),
  kind: Schema.NonEmptyString,
  summary: Schema.optionalKey(Schema.NullOr(Schema.String)),
  partial: Schema.optionalKey(Schema.Boolean),
});
export type RowError = {
  transactionId: string;
  code: "not_found" | "stale" | "invalid_category" | "invalid_row" | "note_hidden";
  message: string;
  currentRev?: string;
};
export type EditResult = {
  changeId: string | null;
  rows: Array<{ transactionId: string; before: Fields; after: Fields }>;
  errors?: RowError[];
  replayed?: boolean;
  response?: Record<string, unknown>;
};
export async function editTransactionFields(
  ctx: WriteContext,
  input: typeof Input.Type,
  database: Pick<typeof db, "transaction"> = db,
): Promise<EditResult> {
  if (!Schema.is(Input)(input))
    throw new LedgerError({ code: "invalid_input", message: "Invalid transaction edits." });
  return runChange<EditResult>(
    ctx,
    input,
    async (tx) => {
      const t = schema.transactions;
      const ids = [...new Set(input.edits.map((e) => e.transactionId))].sort();
      const locked = ids.length
        ? await tx
            .select()
            .from(t)
            .where(and(eq(t.accountId, ctx.actor.accountId), inArray(t.id, ids)))
            .orderBy(asc(t.id))
            .for("update")
        : [];
      const cats = await tx
        .select()
        .from(schema.categories)
        .where(eq(schema.categories.userId, ctx.actor.userId));
      const errors: RowError[] = [];
      const rows: EditResult["rows"] = [];
      const ops: Operation[] = [];
      const seen = new Set<string>();
      for (const edit of input.edits) {
        const row = locked.find((r) => r.id === edit.transactionId);
        const error = (code: RowError["code"], message: string, currentRev?: string) =>
          errors.push({
            transactionId: edit.transactionId,
            code,
            message,
            ...(currentRev ? { currentRev } : {}),
          });
        if (seen.has(edit.transactionId)) {
          error("invalid_row", "Choose each transaction once.");
          continue;
        }
        seen.add(edit.transactionId);
        if (!row) {
          error("not_found", "That transaction isn't available.");
          continue;
        }
        const before = Schema.decodeUnknownSync(Fields)(row);
        // Checked before the guard, so a stale reply never hints whether a guessed note matched.
        if (ctx.source === "mcp" && edit.set.note !== undefined && noteHiddenFromAgent(before.note)) {
          error("note_hidden", "This transaction has a note you can't see. Ask the owner to edit it in Money.");
          continue;
        }
        const rev =
          edit.guard?.rev !== undefined
            ? transactionRev(deriveMcpRevKey(process.env.AUTH_SECRET), ctx.actor.userId, row.id, before)
            : undefined;
        if (!guardMatches(before, edit.guard, rev)) {
          error("stale", "The transaction changed since it was read.", rev);
          continue;
        }
        const cat = cats.find((c) => c.id === edit.set.categoryId);
        if (edit.set.categoryId && !cat) {
          error("invalid_category", "That category isn't available.");
          continue;
        }
        const after = afterFields(before, edit.set, cat?.kind);
        rows.push({ transactionId: row.id, before, after });
        if (!sameFields(before, after)) ops.push({ target: "transaction", id: row.id, before, after });
      }
      if (errors.length && !input.partial)
        return { ops: [], refused: true, result: { changeId: null, rows: [], errors } };
      for (const op of ops)
        if (op.target === "transaction")
          await tx
            .update(t)
            .set(op.after)
            .where(and(eq(t.id, op.id), eq(t.accountId, ctx.actor.accountId)));
      return { ops, result: { changeId: null, rows, ...(errors.length ? { errors } : {}) } };
    },
    database,
  );
}
