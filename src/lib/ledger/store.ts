import "server-only";
import { Schema } from "effect";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { isMissingTable } from "@/lib/db/pg-errors";
import { LedgerError, migrationMessage, type WriteContext } from "./context";
import { idempotencyDecision, type Operation } from "./rules";
export type LedgerTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
class MissingLedger extends Error {}
const changes = schema.ledgerChanges;
const Receipt = Schema.Struct({
  value: Schema.Json,
  response: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
export type ReceiptResult = { replayed?: boolean; response?: Record<string, unknown> };
function receiptResult<R>(raw: unknown): R & ReceiptResult {
  const receipt = Schema.decodeUnknownSync(Receipt)(raw);
  return {
    ...(receipt.value as R),
    ...(receipt.response ? { response: receipt.response } : {}),
    replayed: true,
  };
}

export async function runChange<R extends { changeId: string | null }>(
  ctx: WriteContext,
  meta: { kind: string; summary?: string | null },
  work: (tx: LedgerTx) => Promise<{ ops: Operation[]; result: R; undoes?: string; refused?: boolean }>,
  database: Pick<typeof db, "transaction"> = db,
): Promise<R & ReceiptResult> {
  if (meta.summary && meta.summary.length > 200)
    throw new LedgerError({ code: "invalid_input", message: "Use a reason of at most 200 characters." });
  const execute = (logging: boolean) =>
    database.transaction(async (tx) => {
      const [account] = await tx
        .select({ id: schema.moneyAccounts.id })
        .from(schema.moneyAccounts)
        .where(
          and(
            eq(schema.moneyAccounts.id, ctx.actor.accountId),
            eq(schema.moneyAccounts.userId, ctx.actor.userId),
          ),
        );
      if (!account) throw new LedgerError({ code: "not_found", message: "That account isn't available." });
      if (ctx.idempotency) {
        // Serialize the same key before taking target locks. The unique index is a second line of defence.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${ctx.actor.userId + ":" + ctx.idempotency.key}, 0))`,
        );
      }
      if (ctx.source === "mcp" || ctx.idempotency) {
        let existing;
        try {
          [existing] = await tx
            .select()
            .from(changes)
            .where(
              and(
                eq(changes.userId, ctx.actor.userId),
                ctx.idempotency ? eq(changes.idempotencyKey, ctx.idempotency.key) : sql`false`,
              ),
            )
            .limit(1);
        } catch (e) {
          if (isMissingTable(e)) throw new MissingLedger();
          throw e;
        }
        if (ctx.idempotency && existing) {
          if (
            existing.accountId !== ctx.actor.accountId ||
            idempotencyDecision(existing.requestHash, ctx.idempotency.requestHash) === "conflict"
          )
            throw new LedgerError({
              code: "idempotency_conflict",
              message: "That idempotency key was used for a different request.",
            });
          // Results are written by this core in the same transaction as the operations.
          return receiptResult<R>(existing.result);
        }
      }
      const { ops, result, undoes, refused } = await work(tx);
      if (refused || !logging || (!ops.length && !ctx.idempotency && !undoes)) return result;
      const id = crypto.randomUUID();
      const saved = { ...result, changeId: ops.length || undoes ? id : null };
      const response = ctx.idempotency?.renderResult?.(saved);
      try {
        await tx.insert(changes).values({
          id,
          userId: ctx.actor.userId,
          accountId: ctx.actor.accountId,
          source: ctx.source,
          tokenId: ctx.source === "mcp" ? ctx.tokenId : null,
          sourceLabel: ctx.source === "mcp" ? ctx.label : "You",
          kind: meta.kind,
          summary: meta.summary || null,
          ops,
          undoesChangeId: undoes,
          idempotencyKey: ctx.idempotency?.key,
          requestHash: ctx.idempotency?.requestHash,
          result: ctx.idempotency ? { value: saved, ...(response ? { response } : {}) } : null,
        });
      } catch (e) {
        if (isMissingTable(e)) throw new MissingLedger();
        throw e;
      }
      if (undoes)
        await tx
          .update(changes)
          .set({ undoneByChangeId: id })
          .where(
            and(
              eq(changes.id, undoes),
              eq(changes.userId, ctx.actor.userId),
              eq(changes.accountId, ctx.actor.accountId),
            ),
          );
      return { ...saved, ...(response ? { response } : {}) };
    });
  try {
    return await execute(true);
  } catch (e) {
    if (e instanceof MissingLedger) {
      if (ctx.source === "app") return execute(false);
      throw new LedgerError({ code: "migration_required", message: migrationMessage });
    }
    const pg = e as {
      code?: string;
      constraint_name?: string;
      cause?: { code?: string; constraint_name?: string };
    };
    const unique = pg.code === "23505" ? pg : pg.cause;
    if (
      unique?.code === "23505" &&
      unique.constraint_name === "ledger_change_user_idempotency_uniq" &&
      ctx.idempotency
    ) {
      const replay = await replayChange<R>(ctx);
      if (replay) return replay;
    }
    throw e;
  }
}

/** Check before resolving mutable tool inputs, so retries still work after later edits. */
export async function replayChange<R>(ctx: WriteContext): Promise<(R & ReceiptResult) | null> {
  if (!ctx.idempotency) return null;
  try {
    const [row] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.userId, ctx.actor.userId), eq(changes.idempotencyKey, ctx.idempotency.key)))
      .limit(1);
    if (!row) return null;
    if (
      row.accountId !== ctx.actor.accountId ||
      idempotencyDecision(row.requestHash, ctx.idempotency.requestHash) !== "replay"
    )
      throw new LedgerError({
        code: "idempotency_conflict",
        message: "That idempotency key was used for a different request.",
      });
    return receiptResult<R>(row.result);
  } catch (e) {
    if (isMissingTable(e)) throw new LedgerError({ code: "migration_required", message: migrationMessage });
    throw e;
  }
}
