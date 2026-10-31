import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { Schema } from "effect";
import { db, schema } from "@/db";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
import { isMissingTable } from "@/lib/db/pg-errors";
import { LedgerError, migrationMessage } from "./context";
import { Operations } from "./rules";
/** Newest first. Pass `nextCursor` back as `before` for the next page; it is null on the last page. */
export async function listChanges(actor: MoneyActor, input: { limit?: number; before?: string } = {}) {
  const c = schema.ledgerChanges;
  const limit = Math.max(1, Math.min(50, input.limit ?? 20));
  let before: { id: string } | undefined;
  if (input.before) {
    try {
      before = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.NonEmptyString }))(
        JSON.parse(Buffer.from(input.before, "base64url").toString()),
      );
    } catch {
      throw new LedgerError({ code: "invalid_cursor", message: "Start with a new list_changes request." });
    }
  }
  try {
    const rows = await db
      .select()
      .from(c)
      .innerJoin(
        schema.moneyAccounts,
        and(eq(c.accountId, schema.moneyAccounts.id), eq(schema.moneyAccounts.userId, actor.userId)),
      )
      .where(
        and(
          eq(c.userId, actor.userId),
          eq(c.accountId, actor.accountId),
          before
            ? sql`(${c.createdAt}, ${c.id}) < (select cursor.created_at, cursor.id from ledger_change cursor where cursor.id = ${before.id} and cursor.user_id = ${actor.userId} and cursor.account_id = ${actor.accountId})`
            : undefined,
        ),
      )
      .orderBy(desc(c.createdAt), desc(c.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit).map(({ ledger_change: row }) => ({
      ...row,
      ops: Schema.decodeUnknownSync(Operations)(row.ops),
    }));
    const last = page.at(-1);
    return { rows: page, nextCursor: rows.length > limit && last ? cursorFor(last.id) : null };
  } catch (e) {
    if (isMissingTable(e)) throw new LedgerError({ code: "migration_required", message: migrationMessage });
    throw e;
  }
}
function cursorFor(id: string): string {
  return Buffer.from(JSON.stringify({ id })).toString("base64url");
}
