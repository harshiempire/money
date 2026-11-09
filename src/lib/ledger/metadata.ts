import "server-only";
import { and, eq } from "drizzle-orm";
import { Schema } from "effect";
import { schema } from "@/db";
import { LedgerError, type WriteContext } from "./context";
import { runChange } from "./store";
import type { Operation } from "./rules";

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
