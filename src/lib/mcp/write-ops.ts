import "server-only";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { modelSafeText } from "@/lib/assistant/model-view";
import { editTransactionFields, type EditResult } from "@/lib/ledger/transaction-fields";
import { setPayeeDefault, type PayeeResult } from "@/lib/ledger/payee-default";
import { undoChange, type UndoResult } from "@/lib/ledger/undo";
import { listChanges } from "@/lib/ledger/changes";
import { replayChange } from "@/lib/ledger/store";
import { requestHash } from "@/lib/ledger/rules";
import type { WriteContext } from "@/lib/ledger/context";
import type { McpPrincipal } from "./auth";
import { deriveMcpRefKey, deriveMcpRevKey, transactionRef, transactionRev } from "./refs";
import { mcpReadOps } from "./read-ops";
import { validateTransactionUpdates, resolveCategoryName } from "./update-validation";
import type { UpdateInput, PayeeInput, ChangesInput, UndoInput } from "./write-schemas";

export interface McpWriteOps {
  update(principal: McpPrincipal, input: UpdateInput): Promise<Record<string, unknown>>;
  payee(principal: McpPrincipal, input: PayeeInput): Promise<Record<string, unknown>>;
  changes(principal: McpPrincipal, input: typeof ChangesInput.Type): Promise<Record<string, unknown>>;
  undo(principal: McpPrincipal, input: typeof UndoInput.Type): Promise<Record<string, unknown>>;
}
function context(p: McpPrincipal, tool: string, input: { idempotency_key: string }): WriteContext {
  return {
    actor: p.actor,
    source: "mcp",
    tokenId: p.tokenId,
    label: p.label,
    idempotency: { key: input.idempotency_key, requestHash: requestHash(tool, input) },
  };
}
function refresh() {
  revalidatePath("/transactions");
  revalidatePath("/");
  revalidatePath("/connections");
}
const failure = (code: string, message: string) => ({ applied: false, errors: [{ code, message }] });
const keys = () => ({
  ref: deriveMcpRefKey(process.env.AUTH_SECRET),
  rev: deriveMcpRevKey(process.env.AUTH_SECRET),
});
function editOutput(p: McpPrincipal, result: EditResult): Record<string, unknown> {
  if (result.response) return { ...result.response, ...(result.replayed ? { replayed: true } : {}) };
  const key = keys();
  if (result.errors?.length)
    return {
      applied: false,
      errors: result.errors.map((e) => ({
        ref: transactionRef(key.ref, p.actor.userId, e.transactionId),
        code:
          e.code === "not_found"
            ? "unknown_ref"
            : e.code === "invalid_category"
              ? "unknown_category"
              : e.code,
        message: e.message,
        ...(e.currentRev ? { current_rev: e.currentRev } : {}),
      })),
    };
  return {
    applied: true,
    change_id: result.changeId,
    rows: result.rows.map((row) => ({
      ref: transactionRef(key.ref, p.actor.userId, row.transactionId),
      rev: transactionRev(key.rev, p.actor.userId, row.transactionId, row.after),
    })),
    ...(result.replayed ? { replayed: true } : {}),
  };
}
function payeeOutput(result: PayeeResult): Record<string, unknown> {
  if (result.response) return { ...result.response, ...(result.replayed ? { replayed: true } : {}) };
  return result.confirm
    ? failure(
        "stale",
        "The payee default changed. Read its current default and confirm it before replacing it.",
      )
    : {
        applied: true,
        change_id: result.changeId,
        ...(result.replayed ? { replayed: true } : {}),
      };
}
export const mcpWriteOps: McpWriteOps = {
  async update(p, input) {
    const ctx = context(p, "update_transactions", input);
    ctx.idempotency!.renderResult = (result) => editOutput(p, result as EditResult);
    const replay = await replayChange<EditResult>(ctx);
    if (replay) return editOutput(p, replay);
    const [transactions, categories] = await Promise.all([
      mcpReadOps.listTransactions(p.actor, {}),
      mcpReadOps.listCategories(p.actor),
    ]);
    const key = keys();
    const validated = validateTransactionUpdates(input.rows, {
      transactions: new Map(
        transactions.map((t) => [
          transactionRef(key.ref, p.actor.userId, t.id),
          { id: t.id, rev: transactionRev(key.rev, p.actor.userId, t.id, t) },
        ]),
      ),
      categories,
    });
    if (validated.errors.length) {
      const retry = await replayChange<EditResult>(ctx);
      return retry ? editOutput(p, retry) : { applied: false, errors: validated.errors };
    }
    const result = await editTransactionFields(ctx, {
      edits: validated.edits,
      kind: "transaction_fields",
      ...(input.reason !== undefined ? { summary: input.reason } : {}),
    });
    if (!result.errors?.length) refresh();
    return editOutput(p, result);
  },
  async payee(p, input) {
    const ctx = context(p, "set_payee_default", input);
    ctx.idempotency!.renderResult = (result) => payeeOutput(result as PayeeResult);
    const replay = await replayChange<PayeeResult>(ctx);
    if (replay) return payeeOutput(replay);
    const key = keys();
    const ids = await mcpReadOps.transactionIds(p.actor);
    const id = ids.find((id) => transactionRef(key.ref, p.actor.userId, id) === input.ref);
    if (!id) return failure("unknown_ref", "That ref isn't available in this account.");
    const [txn] = await db
      .select({ counterpartyId: schema.transactions.counterpartyId })
      .from(schema.transactions)
      .where(and(eq(schema.transactions.id, id), eq(schema.transactions.accountId, p.actor.accountId)));
    if (!txn?.counterpartyId) return failure("no_payee", "That transaction has no payee.");
    const categories = await mcpReadOps.listCategories(p.actor);
    const category = (name: string | null) => resolveCategoryName(categories, name);
    const next = category(input.category),
      current = category(input.current_default);
    if (next === undefined || current === undefined)
      return failure("unknown_category", "Use an exact name from list_categories.");
    const result = await setPayeeDefault(ctx, {
      counterpartyId: txn.counterpartyId,
      categoryId: next,
      guard: { currentDefaultCategoryId: current },
    });
    if (!result.confirm) refresh();
    return payeeOutput(result);
  },
  async changes(p, input) {
    const { rows, nextCursor } = await listChanges(p.actor, { limit: input.limit, before: input.cursor });
    return {
      changes: rows.map((row) => ({
        change_id: row.id,
        at: row.createdAt.toISOString(),
        by: modelSafeText(row.sourceLabel, 40) ?? "Agent",
        kind: modelSafeText(row.kind) ?? "change",
        summary: modelSafeText(row.summary, 200),
        rows: row.ops.length,
        undone: row.undoneByChangeId !== null,
        ...(row.undoesChangeId ? { undoes: row.undoesChangeId } : {}),
      })),
      next_cursor: nextCursor,
    };
  },
  async undo(p, input) {
    const ctx = context(p, "undo_change", input);
    ctx.idempotency!.renderResult = (value) => ({ applied: true, change_id: (value as UndoResult).changeId });
    const result = await undoChange(ctx, input.change_id);
    if (result.stale?.length) {
      const key = keys();
      // Payee stale targets are represented by account-scoped transaction refs, never payee ids.
      const refs: string[] = [];
      for (const target of result.stale) {
        if (target.target === "transaction") refs.push(transactionRef(key.ref, p.actor.userId, target.id));
        else {
          const rows = await db
            .select({ id: schema.transactions.id })
            .from(schema.transactions)
            .where(
              and(
                eq(schema.transactions.counterpartyId, target.id),
                eq(schema.transactions.accountId, p.actor.accountId),
              ),
            );
          refs.push(...rows.map((r) => transactionRef(key.ref, p.actor.userId, r.id)));
        }
      }
      return {
        applied: false,
        errors: refs.length
          ? refs.map((ref) => ({
              code: "stale",
              ref,
              message: "This target changed after the original change. Nothing was undone.",
            }))
          : [{ code: "stale", message: "The payee default changed. Nothing was undone." }],
      };
    }
    refresh();
    return {
      ...(result.response ?? { applied: true, change_id: result.changeId }),
      ...(result.replayed ? { replayed: true } : {}),
    };
  },
};
