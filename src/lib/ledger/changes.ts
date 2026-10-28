import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { Schema } from "effect";
import { db, schema } from "@/db";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
import { isMissingTable } from "@/lib/db/pg-errors";
import { LedgerError, migrationMessage } from "./context";
import { Operations } from "./rules";
export async function listChanges(actor: MoneyActor, input: { limit?: number; before?: string } = {}) {
  const c = schema.ledgerChanges;
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
      .limit(Math.max(1, Math.min(50, input.limit ?? 20)));
    return rows.map(({ ledger_change: row }) => ({
      ...row,
      ops: Schema.decodeUnknownSync(Operations)(row.ops),
    }));
  } catch (e) {
    if (isMissingTable(e)) throw new LedgerError({ code: "migration_required", message: migrationMessage });
    throw e;
  }
}
export function changeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ id: row.id })).toString("base64url");
}
