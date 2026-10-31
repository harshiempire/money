import "server-only";
import { and, eq } from "drizzle-orm";
import { Schema } from "effect";
import { schema } from "@/db";
import { LedgerError, type WriteContext } from "./context";
import { inverse, noteHiddenFromAgent, Operations, sameFields, type Operation } from "./rules";
import { runChange } from "./store";
export type UndoResult = {
  changeId: string | null;
  stale?: Array<{ target: Operation["target"]; id: string }>;
  ops?: Operation[];
  replayed?: boolean;
  response?: Record<string, unknown>;
};
export async function undoChange(ctx: WriteContext, changeId: string): Promise<UndoResult> {
  return runChange<UndoResult>(ctx, { kind: "undo" }, async (tx) => {
    const c = schema.ledgerChanges;
    const [change] = await tx
      .select()
      .from(c)
      .where(and(eq(c.id, changeId), eq(c.userId, ctx.actor.userId), eq(c.accountId, ctx.actor.accountId)))
      .for("update");
    if (!change) throw new LedgerError({ code: "not_found", message: "That change isn't available." });
    if (change.undoneByChangeId)
      throw new LedgerError({ code: "already_undone", message: "That change was already undone." });
    const ops = Schema.decodeUnknownSync(Operations)(change.ops);
    const stale: NonNullable<UndoResult["stale"]> = [];
    // Match the core's lock order to avoid deadlocks on overlapping batches.
    for (const op of [...ops].sort((a, b) => a.target.localeCompare(b.target) || a.id.localeCompare(b.id))) {
      if (op.target === "transaction") {
        const t = schema.transactions;
        const [row] = await tx
          .select()
          .from(t)
          .where(and(eq(t.id, op.id), eq(t.accountId, ctx.actor.accountId)))
          .for("update");
        if (
          !row ||
          !sameFields(op.after, {
            categoryId: row.categoryId,
            note: row.note,
            isTransfer: row.isTransfer,
            needsReview: row.needsReview,
          })
        )
          stale.push({ target: op.target, id: op.id });
      } else {
        const p = schema.counterparties;
        const [row] = await tx
          .select()
          .from(p)
          .where(and(eq(p.id, op.id), eq(p.userId, ctx.actor.userId)))
          .for("update");
        if (!row || !sameFields(op.after, { defaultCategoryId: row.defaultCategoryId }))
          stale.push({ target: op.target, id: op.id });
      }
    }
    if (stale.length) return { ops: [], refused: true, result: { changeId: null, stale } };
    // Every target matches its after-values here, so op.after.note is the note on the locked row.
    if (
      ctx.source === "mcp" &&
      ops.some((op) => op.target === "transaction" && op.before.note !== op.after.note && noteHiddenFromAgent(op.after.note))
    )
      throw new LedgerError({
        code: "note_hidden",
        message: "This change replaced a note you can't see. Ask the owner to undo it in Money.",
      });
    const reversed = inverse(ops);
    for (const op of reversed) {
      if (op.target === "transaction")
        await tx
          .update(schema.transactions)
          .set(op.after)
          .where(
            and(eq(schema.transactions.id, op.id), eq(schema.transactions.accountId, ctx.actor.accountId)),
          );
      else
        await tx
          .update(schema.counterparties)
          .set(op.after)
          .where(
            and(eq(schema.counterparties.id, op.id), eq(schema.counterparties.userId, ctx.actor.userId)),
          );
    }
    return { ops: reversed, undoes: changeId, result: { changeId: null, ops: reversed } };
  });
}
