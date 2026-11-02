import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { Schema } from "effect";
import { schema } from "@/db";
import { LedgerError, type WriteContext } from "./context";
import { inverse, Operations, sameFields, type Operation, type RowOperation } from "./rules";
import { runChange } from "./store";
import { lockRelationalActor, relationalSnapshot, applyRowOperations } from "./relational-store";
export type UndoResult = {
  changeId: string | null;
  stale?: Array<{ target: Operation["target"]; id: string }>;
  ops?: Operation[];
  replayed?: boolean;
  response?: Record<string, unknown>;
};
export async function undoChange(ctx: WriteContext, changeId: string): Promise<UndoResult> {
  return runChange<UndoResult>(ctx, { kind: "undo" }, async (tx) => {
    // Same actor/row lock order as all relational cores. Take it before the
    // change-row lock so two simultaneous undos cannot invert the order.
    await lockRelationalActor(tx, ctx);
    const snapshot = await relationalSnapshot(tx, ctx, true);
    const c = schema.ledgerChanges;
    const [change] = await tx
      .select()
      .from(c)
      .where(and(eq(c.id, changeId), eq(c.userId, ctx.actor.userId), eq(c.accountId, ctx.actor.accountId)))
      .for("update");
    if (!change)
      throw new LedgerError({
        code: "not_found",
        message: "That change isn't available.",
      });
    if (change.undoneByChangeId)
      throw new LedgerError({
        code: "already_undone",
        message: "That change was already undone.",
      });
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
      } else if (op.target === "counterparty" || op.target === "counterparty_name") {
        const p = schema.counterparties;
        const [row] = await tx
          .select()
          .from(p)
          .where(and(eq(p.id, op.id), eq(p.userId, ctx.actor.userId)))
          .for("update");
        if (!row || !sameFields(op.after, op.target === "counterparty" ? { defaultCategoryId: row.defaultCategoryId } : { displayName: row.displayName }))
          stale.push({ target: op.target, id: op.id });
      } else if (op.target === "standing_note") {
        const n = schema.assistantContextNotes;
        const [row] = await tx.select({ userId: n.userId, body: n.body,
          createdAt: sql<string>`${n.createdAt}::text`, updatedAt: sql<string>`${n.updatedAt}::text` })
          .from(n).where(and(eq(n.id, op.id), eq(n.userId, ctx.actor.userId))).for("update");
        if (!sameFields(op.after, row ?? null)) stale.push({ target: op.target, id: op.id });
      } else {
        const current = snapshot.get(`${op.target}:${op.id}`)?.after ?? null;
        if (!sameFields(op.after, current)) stale.push({ target: op.target, id: op.id });
      }
    }
    if (stale.length) return { ops: [], refused: true, result: { changeId: null, stale } };
    const reversed = inverse(ops);
    for (const op of reversed) {
      if (op.target === "transaction")
        await tx
          .update(schema.transactions)
          .set(op.after)
          .where(
            and(eq(schema.transactions.id, op.id), eq(schema.transactions.accountId, ctx.actor.accountId)),
          );
      else if (op.target === "counterparty" || op.target === "counterparty_name")
        await tx
          .update(schema.counterparties)
          .set(op.after)
          .where(
            and(eq(schema.counterparties.id, op.id), eq(schema.counterparties.userId, ctx.actor.userId)),
          );
      else if (op.target === "standing_note") {
        const n = schema.assistantContextNotes;
        if (!op.after) await tx.delete(n).where(and(eq(n.id, op.id), eq(n.userId, ctx.actor.userId)));
        else await tx.insert(n).values({ id: op.id, ...op.after,
          createdAt: sql`${op.after.createdAt}::timestamptz`, updatedAt: sql`${op.after.updatedAt}::timestamptz` });
      }
    }
    await applyRowOperations(
      tx,
      reversed.filter(
        (op): op is RowOperation => op.target !== "transaction" && op.target !== "counterparty" && op.target !== "counterparty_name" && op.target !== "standing_note",
      ),
    );
    return {
      ops: reversed,
      undoes: changeId,
      result: { changeId: null, ops: reversed },
    };
  });
}
