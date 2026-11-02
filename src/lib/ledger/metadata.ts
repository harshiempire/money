import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { Schema } from "effect";
import { schema } from "@/db";
import { LedgerError, type WriteContext } from "./context";
import { runChange } from "./store";
import { lockRelationalActor } from "./relational-store";
import type { Operation } from "./rules";
import { isMissingTable } from "@/lib/db/pg-errors";

const NameInput = Schema.Struct({ counterpartyId: Schema.NonEmptyString,
  displayName: Schema.String.check(Schema.isMaxLength(200), Schema.makeFilter(s => s.trim().length > 0)),
  currentDisplayName: Schema.NullOr(Schema.String) });
export async function renamePayee(ctx: WriteContext, input: typeof NameInput.Type) {
  if (!Schema.is(NameInput)(input)) throw new LedgerError({ code: "invalid_input", message: "Use a nonblank display name of at most 200 characters." });
  return runChange(ctx, { kind: "rename_payee", summary: ctx.summary ?? "Renamed payee" }, async tx => {
    const p = schema.counterparties;
    const [row] = await tx.select().from(p).where(and(eq(p.id, input.counterpartyId), eq(p.userId, ctx.actor.userId))).for("update");
    if (!row) throw new LedgerError({ code: "not_found", message: "That payee isn't available." });
    if (row.displayName !== input.currentDisplayName) throw new LedgerError({ code: "stale", message: "The display name changed. Read and confirm its current display name." });
    const after = { displayName: input.displayName.trim() };
    const ops: Operation[] = row.displayName === after.displayName ? [] : [{ target: "counterparty_name", id: row.id, before: { displayName: row.displayName }, after }];
    if (ops.length) await tx.update(p).set(after).where(eq(p.id, row.id));
    return { ops, result: { changeId: null, ops } };
  });
}

const Body = Schema.String.check(Schema.isMaxLength(500), Schema.makeFilter(s => s.trim().length > 0));
export async function addStandingNote(ctx: WriteContext, body: string) {
  if (!Schema.is(Body)(body)) throw new LedgerError({ code: "invalid_input", message: "Use a nonblank note of at most 500 characters." });
  try {
    return await runChange(ctx, { kind: "add_standing_note", summary: ctx.summary ?? "Added standing note" }, async tx => {
      await lockRelationalActor(tx, ctx);
      // Serialize MCP inserts and retain row locks for existing note edits.
      const n = schema.assistantContextNotes;
      const rows = await tx.select({ id: n.id }).from(n).where(eq(n.userId, ctx.actor.userId)).for("update");
      if (rows.length >= 40) throw new LedgerError({ code: "limit_reached", message: "Notes are limited to 40." });
      const [created] = await tx.insert(n).values({ userId: ctx.actor.userId, body: body.trim() }).returning({ id: n.id, userId: n.userId, body: n.body,
        createdAt: sql<string>`${n.createdAt}::text`, updatedAt: sql<string>`${n.updatedAt}::text` });
      const { id, ...after } = created;
      const ops: Operation[] = [{ target: "standing_note", id, before: null, after }];
      return { ops, result: { changeId: null, ops } };
    });
  } catch (e) {
    if (isMissingTable(e)) throw new LedgerError({ code: "migration_required", message: "Notes aren't available until migration 0012 is applied." });
    throw e;
  }
}
