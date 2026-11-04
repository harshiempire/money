import { refreshPaths } from "@/lib/ledger/capabilities";
import "server-only";
import { Effect, Schema } from "effect";
import type { ActionSpec } from "@/lib/action/core";
import { sanitizedInput } from "@/lib/action/sanitized-input";
import { Conflict, Invalid, NotFound, Unavailable } from "@/lib/action/errors";
import { fromLedger } from "@/lib/action/ledger";
import { CurrentUser, type Db } from "@/lib/action/services";
import { LedgerError } from "@/lib/ledger/context";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { createToken, listTokens, revokeToken } from "@/lib/mcp/token-store";
import type { MoneyActor } from "@/lib/assistant/actor-ops";

// Shared with the server component: pages read the libraries directly, never actions.
export async function readLedgerChanges(actor: MoneyActor, before?: string) {
  try {
    const { listChanges } = await import("@/lib/ledger/changes");
    const page = await listChanges(actor, { limit: 20, ...(before !== undefined ? { before } : {}) });
    return { available: true as const, nextCursor: page.nextCursor, rows: page.rows.map((row) => ({
      id: row.id, at: row.createdAt.toISOString(), by: row.sourceLabel, summary: row.summary,
      kind: row.kind, count: row.ops.length, undone: row.undoneByChangeId !== null,
    })) };
  } catch (e) {
    if (e instanceof LedgerError && e.code === "migration_required")
      return { available: false as const, nextCursor: null, rows: [] };
    throw e;
  }
}

export const listMcpTokensSpec: ActionSpec<void, void, Awaited<ReturnType<typeof listTokens>>, CurrentUser | Db> = {
  input: Schema.Void,
  handler: Effect.fn("listMcpTokens")(function* () {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
    return yield* Effect.promise(() => listTokens({ userId: user.id, accountId: account.id }));
  }),
};

const createMcpTokenInput = sanitizedInput({ name: Schema.optional(Schema.Unknown), scope: Schema.optional(Schema.Unknown) });
export const createMcpTokenSpec: ActionSpec<
  typeof createMcpTokenInput.Type, typeof createMcpTokenInput.Encoded,
  { token: string; hint: string; id: string }, CurrentUser | Db
> = {
  input: createMcpTokenInput,
  handler: Effect.fn("createMcpToken")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
    const result = yield* Effect.promise(() => createToken({ userId: user.id, accountId: account.id }, input));
    if (!result.ok) {
      if (result.error === "That account isn't available.") return yield* new NotFound({ message: result.error });
      if (result.error === "Revoke a token first. You can have up to 10 active tokens.") return yield* new Conflict({ message: result.error });
      if (result.error === "Tokens aren't available until migration 0013 is applied.") return yield* new Unavailable({ message: result.error });
      return yield* new Invalid({ message: result.error });
    }
    return { token: result.token, hint: result.hint, id: result.id };
  }),
};

const revokeMcpTokenInput = sanitizedInput({ id: Schema.optional(Schema.Unknown) });
export const revokeMcpTokenSpec: ActionSpec<
  typeof revokeMcpTokenInput.Type, typeof revokeMcpTokenInput.Encoded, void, CurrentUser | Db
> = {
  input: revokeMcpTokenInput,
  handler: Effect.fn("revokeMcpToken")(function* (input) {
    const user = yield* CurrentUser;
    if (typeof input?.id !== "string" || !input.id) return yield* new Invalid({ message: "Choose a token first." });
    const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
    const id = input.id;
    const result = yield* Effect.promise(() => revokeToken({ userId: user.id, accountId: account.id }, id));
    if (!result.ok) return yield* result.error === "That token isn't available."
      ? new NotFound({ message: result.error }) : new Unavailable({ message: result.error });
    return;
  }),
};

const listLedgerChangesInput = sanitizedInput({ before: Schema.optional(Schema.Unknown) });
export const listLedgerChangesSpec: ActionSpec<
  typeof listLedgerChangesInput.Type, typeof listLedgerChangesInput.Encoded,
  Awaited<ReturnType<typeof readLedgerChanges>>, CurrentUser | Db
> = {
  input: listLedgerChangesInput,
  handler: Effect.fn("listLedgerChanges")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
    const before = typeof input?.before === "string" && input.before ? input.before : undefined;
    return yield* fromLedger(() => readLedgerChanges({ userId: user.id, accountId: account.id }, before));
  }),
};

const undoLedgerChangeInput = sanitizedInput({ changeId: Schema.optional(Schema.Unknown) });
export const undoLedgerChangeSpec: ActionSpec<
  typeof undoLedgerChangeInput.Type, typeof undoLedgerChangeInput.Encoded, void, CurrentUser | Db
> = {
  input: undoLedgerChangeInput,
  revalidate: refreshPaths("change.undo"),
  handler: Effect.fn("undoLedgerChange")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
    if (typeof input?.changeId !== "string" || !input.changeId) return yield* new Invalid({ message: "Choose a change first." });
    const changeId = input.changeId;
    const { undoChange } = yield* Effect.promise(() => import("@/lib/ledger/undo"));
    const result = yield* fromLedger(() => undoChange({ actor: { userId: user.id, accountId: account.id }, source: "app" }, changeId));
    if (result.stale?.length) return yield* new Conflict({ message: "Nothing was undone. A target or its related shares, settlements or people changed after this change. Review the latest values first." });
    return;
  }),
};
