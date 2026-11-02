/**
 * Throwaway DB only. Never load a .env file:
 * MONEY_LEDGER_TEST_DB=1 DATABASE_URL="$(cat $HOME/.money-scratch/neon-writes/dburl)" \
 *   bun --no-env-file test --conditions react-server src/lib/ledger/ledger.db.test.ts
 * (`--conditions` must come after `test`; before it, `server-only` throws.)
 * Seeds random private fixtures and deletes them. The missing-table test renames
 * the log only inside a transaction that is always rolled back.
 */
import { describe, expect, test, mock } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { deriveMcpRevKey, transactionRev } from "@/lib/mcp/refs";
import { requestHash } from "./rules";
import type { WriteContext } from "./context";
const enabled = process.env.MONEY_LEDGER_TEST_DB === "1";
const revalidated: string[] = [];
if (enabled) mock.module("next/cache", () => ({ revalidatePath: (path: string) => revalidated.push(path) }));
if (enabled && !process.env.DATABASE_URL)
  throw new Error(
    "MONEY_LEDGER_TEST_DB requires an explicitly supplied DATABASE_URL. Do not load .env files.",
  );

describe.skipIf(!enabled)("ledger throwaway DB", () => {
  async function fixture(run: (f: Awaited<ReturnType<typeof seed>>) => Promise<void>) {
    const f = await seed();
    try {
      await run(f);
    } finally {
      await f.db
        .delete(f.schema.transactions)
        .where(inArray(f.schema.transactions.accountId, [f.actor.accountId, f.otherAccount]));
      await f.db.delete(f.schema.users).where(inArray(f.schema.users.id, [f.actor.userId, f.otherUser]));
    }
  }
  async function seed() {
    const { db, schema } = await import("@/db");
    const { editTransactionFields } = await import("./transaction-fields");
    const { undoChange } = await import("./undo");
    const { setPayeeDefault } = await import("./payee-default");
    const { listChanges } = await import("./changes");
    const id = () => crypto.randomUUID();
    const actor = { userId: id(), accountId: id() },
      otherUser = id(),
      otherAccount = id();
    const food = id(),
      transfer = id(),
      investment = id(),
      payee = id(),
      tokenId = id();
    const ids = [id(), id()],
      otherId = id();
    await db.insert(schema.users).values([
      { id: actor.userId, email: `${actor.userId}@ledger.test` },
      { id: otherUser, email: `${otherUser}@ledger.test` },
    ]);
    try {
      await db.insert(schema.moneyAccounts).values([
        {
          id: actor.accountId,
          userId: actor.userId,
          bank: "bob",
          name: "Test",
          openingDate: "2026-01-01",
          openingBalancePaise: 0,
        },
        {
          id: otherAccount,
          userId: otherUser,
          bank: "bob",
          name: "Other",
          openingDate: "2026-01-01",
          openingBalancePaise: 0,
        },
      ]);
      await db.insert(schema.categories).values([
        { id: food, userId: actor.userId, name: "Food", kind: "spend" },
        { id: transfer, userId: actor.userId, name: "Transfer", kind: "transfer" },
        { id: investment, userId: actor.userId, name: "Investment", kind: "investment" },
      ]);
      await db
        .insert(schema.counterparties)
        .values({ id: payee, userId: actor.userId, key: id(), kind: "merchant", displayName: "Lunch" });
      await db
        .insert(schema.mcpTokens)
        .values({
          id: tokenId,
          userId: actor.userId,
          accountId: actor.accountId,
          name: "Test agent",
          tokenHash: id(),
          tokenHint: "mny_test",
          scope: "write",
          userTokenVersion: 0,
        });
      await db.insert(schema.transactions).values(
        [
          ...ids.map((id) => ({ id, accountId: actor.accountId })),
          { id: otherId, accountId: otherAccount },
        ].map((row) => ({
          ...row,
          txnDate: "2026-10-01",
          amountPaise: 10000,
          drCr: "debit" as const,
          channel: "other" as const,
          refId: id(),
          rawDescription: "test",
          counterpartyId: row.accountId === actor.accountId ? payee : null,
        })),
      );
    } catch (e) {
      await db.delete(schema.users).where(inArray(schema.users.id, [actor.userId, otherUser]));
      throw e;
    }
    const app: WriteContext = { actor, source: "app" };
    const mcp = (key: string, args: unknown = {}): WriteContext => ({
      actor,
      source: "mcp",
      tokenId,
      label: "Test agent",
      idempotency: { key, requestHash: requestHash("test", args) },
    });
    const read = async (transactionId = ids[0]) =>
      (await db.select().from(schema.transactions).where(eq(schema.transactions.id, transactionId)))[0];
    return {
      db,
      schema,
      actor,
      tokenId,
      otherUser,
      otherAccount,
      otherId,
      ids,
      food,
      transfer,
      investment,
      payee,
      app,
      mcp,
      read,
      editTransactionFields,
      undoChange,
      setPayeeDefault,
      listPage: listChanges,
      listChanges: async (a: typeof actor) => (await listChanges(a)).rows,
    };
  }
  test(
    "migration created log, indexes and write scope check",
    () =>
      fixture(async (f) => {
        const rows = await f.db.execute(
          sql`select conname, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'public.mcp_token'::regclass and conname = 'mcp_token_scope_check'`,
        );
        expect(String(rows[0].definition)).toContain("write");
        const indexes = await f.db.execute(
          sql`select indexdef from pg_indexes where tablename = 'ledger_change'`,
        );
        expect(
          indexes.some((r) => String(r.indexdef).includes("UNIQUE") && String(r.indexdef).includes("WHERE")),
        ).toBe(true);
        const columns = await f.db.execute(
          sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'ledger_change'`,
        );
        expect(columns).toHaveLength(15);
      }),
    60000,
  );
  test(
    "all-or-nothing on a stale row, without log entries",
    () =>
      fixture(async (f) => {
        const result = await f.editTransactionFields(f.app, {
          kind: "transaction_fields",
          edits: [
            { transactionId: f.ids[0], set: { note: "new" } },
            { transactionId: f.ids[1], set: { note: "new" }, guard: { note: "old" } },
          ],
        });
        expect(result.errors?.map((e) => e.code)).toEqual(["stale"]);
        expect((await f.read()).note).toBeNull();
        expect(await f.listChanges(f.actor)).toHaveLength(0);
      }),
    60000,
  );
  test(
    "FOR UPDATE permits exactly one concurrent guarded edit",
    () =>
      fixture(async (f) => {
        const results = await Promise.all(
          ["first", "second"].map((note) =>
            f.editTransactionFields(f.app, {
              kind: "transaction_fields",
              edits: [{ transactionId: f.ids[0], set: { note }, guard: { note: null } }],
            }),
          ),
        );
        expect(results.filter((r) => !r.errors)).toHaveLength(1);
        expect(results.filter((r) => r.errors?.[0].code === "stale")).toHaveLength(1);
        expect(await f.listChanges(f.actor)).toHaveLength(1);
      }),
    60000,
  );
  test(
    "idempotent replay, conflict and concurrent one-key race",
    () =>
      fixture(async (f) => {
        const input = {
          kind: "transaction_fields",
          edits: [{ transactionId: f.ids[0], set: { note: "new" }, guard: { note: null } }],
        };
        const ctx = f.mcp("same-key-123", input);
        const result = await f.editTransactionFields(ctx, input);
        const replay = await f.editTransactionFields(ctx, input);
        expect(replay.replayed).toBe(true);
        expect(replay.changeId).toBe(result.changeId);
        await expect(
          f.editTransactionFields(f.mcp("same-key-123", { different: true }), input),
        ).rejects.toMatchObject({ code: "idempotency_conflict" });
        const next = {
          ...input,
          edits: [{ transactionId: f.ids[1], set: { note: "other" }, guard: { note: null } }],
        };
        const concurrent = await Promise.all(
          [1, 2].map(() => f.editTransactionFields(f.mcp("race-key-123", next), next)),
        );
        expect(concurrent.filter((r) => r.replayed)).toHaveLength(1);
        expect(new Set(concurrent.map((r) => r.changeId)).size).toBe(1);
        expect(await f.listChanges(f.actor)).toHaveLength(2);
      }),
    60000,
  );
  test(
    "undo restores before, undo of undo restores after, repeated undo refused",
    () =>
      fixture(async (f) => {
        const result = await f.editTransactionFields(f.mcp("undo-key-123"), {
          kind: "transaction_fields",
          edits: [
            { transactionId: f.ids[0], set: { categoryId: f.transfer, note: " new ", needsReview: true } },
          ],
        });
        const undo = await f.undoChange(f.app, result.changeId!);
        expect((await f.read()).note).toBeNull();
        expect((await f.read()).isTransfer).toBe(false);
        const redo = await f.undoChange(f.mcp("redo-key-123"), undo.changeId!);
        expect(redo.changeId).not.toBeNull();
        expect((await f.read()).note).toBe("new");
        expect((await f.read()).needsReview).toBe(true);
        await expect(f.undoChange(f.app, result.changeId!)).rejects.toMatchObject({ code: "already_undone" });
        const changes = await f.listChanges(f.actor);
        expect(changes.find((c) => c.id === result.changeId)?.undoneByChangeId).toBe(undo.changeId);
      }),
    60000,
  );
  test(
    "undo refuses every target after a later edit",
    () =>
      fixture(async (f) => {
        const result = await f.editTransactionFields(f.app, {
          kind: "transaction_fields",
          edits: f.ids.map((transactionId) => ({ transactionId, set: { note: "first" } })),
        });
        await f.editTransactionFields(f.app, {
          kind: "transaction_fields",
          edits: [{ transactionId: f.ids[0], set: { needsReview: true } }],
        });
        const undo = await f.undoChange(f.app, result.changeId!);
        expect(undo.stale).toEqual([{ target: "transaction", id: f.ids[0] }]);
        expect((await f.read(f.ids[1])).note).toBe("first");
        expect(await f.listChanges(f.actor)).toHaveLength(2);
      }),
    60000,
  );
  test(
    "cross-tenant id and mismatched actor account are refused",
    () =>
      fixture(async (f) => {
        const result = await f.editTransactionFields(f.app, {
          kind: "transaction_fields",
          edits: [{ transactionId: f.otherId, set: { note: "bad" } }],
        });
        expect(result.errors?.[0].code).toBe("not_found");
        expect((await f.read(f.otherId)).note).toBeNull();
        await expect(
          f.editTransactionFields(
            { actor: { ...f.actor, userId: f.otherUser }, source: "app" },
            { kind: "transaction_fields", edits: [{ transactionId: f.ids[0], set: { note: "bad" } }] },
          ),
        ).rejects.toMatchObject({ code: "not_found" });
      }),
    60000,
  );
  test(
    "app logging works, missing log falls back only for app and rolls back the failed attempt",
    () =>
      fixture(async (f) => {
        const input = {
          kind: "transaction_fields",
          edits: [{ transactionId: f.ids[0], set: { note: "logged" } }],
        };
        expect((await f.editTransactionFields(f.app, input)).changeId).not.toBeNull();
        const rollback = new Error("rollback missing-table fixture");
        await expect(
          f.db.transaction(async (tx) => {
            await tx.execute(sql`alter table ledger_change rename to ledger_change_test_hidden`);
            const result = await f.editTransactionFields(
              f.app,
              { ...input, edits: [{ transactionId: f.ids[0], set: { note: "without log" } }] },
              tx,
            );
            expect(result.changeId).toBeNull();
            const [row] = await tx
              .select()
              .from(f.schema.transactions)
              .where(eq(f.schema.transactions.id, f.ids[0]));
            expect(row.note).toBe("without log");
            await expect(f.editTransactionFields(f.mcp("missing-key-123"), input, tx)).rejects.toMatchObject({
              code: "migration_required",
            });
            throw rollback;
          }),
        ).rejects.toBe(rollback);
        expect((await f.read()).note).toBe("logged");
        expect(await f.listChanges(f.actor)).toHaveLength(1);
      }),
    60000,
  );
  test(
    "category transfer rule, explicit override, revision guard and no-op",
    () =>
      fixture(async (f) => {
        for (const categoryId of [f.transfer, f.investment]) {
          await f.editTransactionFields(f.app, {
            kind: "transaction_fields",
            edits: [{ transactionId: f.ids[0], set: { categoryId } }],
          });
          expect((await f.read()).isTransfer).toBe(true);
        }
        await f.editTransactionFields(f.app, {
          kind: "transaction_fields",
          edits: [{ transactionId: f.ids[0], set: { categoryId: f.transfer, isTransfer: false } }],
        });
        expect((await f.read()).isTransfer).toBe(false);
        const row = await f.read();
        const previous = process.env.AUTH_SECRET;
        process.env.AUTH_SECRET = "ledger-test-secret";
        try {
          const rev = transactionRev(deriveMcpRevKey(process.env.AUTH_SECRET), f.actor.userId, row.id, row);
          await f.editTransactionFields(f.app, {
            kind: "transaction_fields",
            edits: [{ transactionId: row.id, set: { note: "private@bank" }, guard: { rev } }],
          });
          const stale = await f.editTransactionFields(f.app, {
            kind: "transaction_fields",
            edits: [{ transactionId: row.id, set: { note: null }, guard: { rev } }],
          });
          expect(stale.errors?.[0].code).toBe("stale");
          expect(stale.errors?.[0].currentRev).toMatch(/^rev_/);
          const noop = await f.editTransactionFields(f.app, {
            kind: "transaction_fields",
            edits: [{ transactionId: row.id, set: { note: "private@bank" } }],
          });
          expect(noop.changeId).toBeNull();
        } finally {
          if (previous === undefined) delete process.env.AUTH_SECRET;
          else process.env.AUTH_SECRET = previous;
        }
      }),
    60000,
  );
  test(
    "payee default confirmation, clear and undo use locked values",
    () =>
      fixture(async (f) => {
        await f.setPayeeDefault(f.app, { counterpartyId: f.payee, categoryId: f.food, guard: {} });
        const confirmation = await f.setPayeeDefault(f.app, {
          counterpartyId: f.payee,
          categoryId: f.transfer,
          guard: {},
        });
        expect(confirmation.confirm).toBe(true);
        const result = await f.setPayeeDefault(f.mcp("payee-key-123"), {
          counterpartyId: f.payee,
          categoryId: null,
          guard: { currentDefaultCategoryId: f.food },
        });
        await f.undoChange(f.app, result.changeId!);
        const [payee] = await f.db
          .select()
          .from(f.schema.counterparties)
          .where(
            and(eq(f.schema.counterparties.id, f.payee), eq(f.schema.counterparties.userId, f.actor.userId)),
          );
        expect(payee.defaultCategoryId).toBe(f.food);
      }),
    60000,
  );
  test(
    "MCP adapters persist exact replies, return full history, reject atomic batches and expose payee defaults",
    () =>
      fixture(async (f) => {
        const { mcpWriteOps } = await import("@/lib/mcp/write-ops");
        const { mcpReadOps } = await import("@/lib/mcp/read-ops");
        const { deriveMcpRefKey, transactionRef } = await import("@/lib/mcp/refs");
        const previous = process.env.AUTH_SECRET;
        process.env.AUTH_SECRET = "adapter-test-secret";
        const principal = {
          actor: f.actor,
          scope: "write" as const,
          tokenId: f.tokenId,
          label: "private@bank",
        };
        try {
          const ref = transactionRef(deriveMcpRefKey(process.env.AUTH_SECRET), f.actor.userId, f.ids[0]);
          const rev = transactionRev(
            deriveMcpRevKey(process.env.AUTH_SECRET),
            f.actor.userId,
            f.ids[0],
            await f.read(),
          );
          const input = {
            rows: [{ ref, rev, note: "private@bank" }],
            reason: "account 12345678",
            idempotency_key: "adapter-update-123",
          };
          const refused = await mcpWriteOps.update(principal, {
            ...input,
            rows: [...input.rows, { ref: "missing", rev, note: "bad" }],
          });
          expect(refused.applied).toBe(false);
          expect((await f.read()).note).toBeNull();
          const first = await mcpWriteOps.update(principal, input);
          expect(first.applied).toBe(true);
          await f.editTransactionFields(f.app, {
            kind: "transaction_fields",
            edits: [{ transactionId: f.ids[0], set: { note: "later" } }],
          });
          process.env.AUTH_SECRET = "rotated-adapter-secret";
          const replay = await mcpWriteOps.update(principal, input);
          expect(replay).toEqual({ ...first, replayed: true });
          process.env.AUTH_SECRET = "adapter-test-secret";
          const noReason = await mcpWriteOps.update(principal, {
            rows: [
              {
                ref,
                rev: transactionRev(deriveMcpRevKey(process.env.AUTH_SECRET), f.actor.userId, f.ids[0], await f.read()),
                needs_review: true,
              },
            ],
            idempotency_key: "adapter-update-no-reason",
          });
          expect(noReason.applied).toBe(true);
          expect((await f.read()).needsReview).toBe(true);
          const history = await mcpWriteOps.changes(principal, { limit: 50 });
          expect(JSON.stringify(history)).toContain("private@bank");
          expect(JSON.stringify(history)).toContain("12345678");
          expect(JSON.stringify(history)).not.toContain(f.actor.userId);
          expect(JSON.stringify(history)).not.toContain(f.ids[0]);
          const payee = await mcpWriteOps.payee(principal, {
            ref,
            category: "Food",
            current_default: null,
            idempotency_key: "adapter-payee-123",
          });
          expect(payee.applied).toBe(true);
          expect(
            (await mcpReadOps.listTransactions(f.actor, {})).find((r) => r.id === f.ids[0])?.defaultCategory,
          ).toBe("Food");
          expect(
            (
              await mcpWriteOps.payee(principal, {
                ref,
                category: "Transfer",
                current_default: null,
                idempotency_key: "adapter-payee-bad",
              })
            ).applied,
          ).toBe(false);
          const staleUndo = await mcpWriteOps.undo(principal, {
            change_id: first.change_id as string,
            idempotency_key: "adapter-stale-undo",
          });
          expect(staleUndo.applied).toBe(false);
          expect(JSON.stringify(staleUndo)).toContain(ref);
          expect(JSON.stringify(staleUndo)).not.toContain(f.ids[0]);
          const undo = await mcpWriteOps.undo(principal, {
            change_id: payee.change_id as string,
            idempotency_key: "adapter-payee-undo",
          });
          expect(undo.applied).toBe(true);
          expect(
            await mcpWriteOps.undo(principal, {
              change_id: payee.change_id as string,
              idempotency_key: "adapter-payee-undo",
            }),
          ).toEqual({ ...undo, replayed: true });
          expect(revalidated).toContain("/transactions");
          expect(revalidated).toContain("/");
        } finally {
          if (previous === undefined) delete process.env.AUTH_SECRET;
          else process.env.AUTH_SECRET = previous;
        }
      }),
    90000,
  );
  test(
    "no-op app edits do not log; no-op MCP receipts replay without a finance change",
    () =>
      fixture(async (f) => {
        const input = {
          kind: "transaction_fields",
          edits: [{ transactionId: f.ids[0], set: { note: null } }],
        };
        expect((await f.editTransactionFields(f.app, input)).changeId).toBeNull();
        expect(await f.listChanges(f.actor)).toHaveLength(0);
        const ctx = f.mcp("noop-key-123");
        const result = await f.editTransactionFields(ctx, input);
        expect(result.changeId).toBeNull();
        expect((await f.listChanges(f.actor))[0].ops).toEqual([]);
        expect((await f.editTransactionFields(ctx, input)).replayed).toBe(true);
      }),
    60000,
  );
  test(
    "change history pages until every change is reachable",
    () =>
      fixture(async (f) => {
        for (const note of ["one", "two", "three"])
          await f.editTransactionFields(f.app, {
            kind: "transaction_fields",
            edits: [{ transactionId: f.ids[0], set: { note } }],
          });
        const first = await f.listPage(f.actor, { limit: 2 });
        expect(first.rows).toHaveLength(2);
        expect(first.nextCursor).not.toBeNull();
        const second = await f.listPage(f.actor, { limit: 2, before: first.nextCursor! });
        expect(second.rows).toHaveLength(1);
        expect(second.nextCursor).toBeNull();
        expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(3);
        expect((await f.listPage(f.actor, { limit: 3 })).nextCursor).toBeNull();
      }),
    60000,
  );
});
