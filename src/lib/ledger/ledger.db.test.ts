import { indiaTodayIso } from "@/lib/dates/india";
/**
 * Throwaway DB only. Never load a .env file:
 * Set MONEY_LEDGER_TEST_DBURL_FILE to a local file holding the throwaway URL;
 * the test refuses any other DATABASE_URL and local-dev. Always pass --no-env-file.
 * (`--conditions` must come after `test`; before it, `server-only` throws.)
 * Seeds random private fixtures and deletes them. The missing-table test renames
 * the log only inside a transaction that is always rolled back.
 */
import { describe, expect, test, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { deriveMcpRevKey, transactionRev } from "@/lib/mcp/refs";
import { requestHash } from "./rules";
import { LedgerError, type LedgerErrorCode, type WriteContext } from "./context";
import { ForbiddenError } from "@/lib/auth/forbidden";
const enabled = process.env.MONEY_LEDGER_TEST_DB === "1";
const revalidated: string[] = [];
if (enabled) mock.module("next/cache", () => ({ revalidatePath: (path: string) => revalidated.push(path) }));
if (enabled && !process.env.DATABASE_URL)
  throw new Error(
    "MONEY_LEDGER_TEST_DB requires an explicitly supplied DATABASE_URL. Do not load .env files.",
  );
const readUrl = (file: string | undefined) => {
  if (!file) return null;
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
};
if (enabled && process.env.DATABASE_URL !== readUrl(process.env.MONEY_LEDGER_TEST_DBURL_FILE))
  throw new Error("Ledger DB tests run only against the throwaway URL in MONEY_LEDGER_TEST_DBURL_FILE.");
if (enabled) {
  const target = new URL(process.env.DATABASE_URL!);
  if (target.hostname !== "127.0.0.1" || target.port !== "54330" || target.pathname !== "/money_test")
    throw new Error("Ledger DB tests require the authorized local money_test database.");
}

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
  async function expectLedger(run: Promise<unknown>, code: LedgerErrorCode, message: string) {
    const error = await run.then(() => null, (error: unknown) => error);
    expect(error).toBeInstanceOf(LedgerError);
    expect(error).toMatchObject({ code, message });
    expect((error as Error).message).toBe(message);
  }

  test("net both payable fields are rejected before any database or ownership work", async () => {
    const core = await import("./net-events");
    const { runLedger } = await import("./run");
    const saveNetEvent = (ctx: WriteContext, input: Parameters<typeof core.saveNetEvent>[1]) => runLedger(core.saveNetEvent(ctx, input), ctx.actor);
    // Invalid UUIDs would fail at the database boundary if validation got that far.
    const ctx: WriteContext = { source: "app", actor: { userId: "no-db-user", accountId: "no-db-account" } };
    const malformed = {
      kind: "payable" as const, method: "offset" as const, amountPaise: 100,
      owedExpenseId: "no-db-payable",
      newPayable: { personName: "Asha", incurredDate: "2026-10-01", amountPaise: -1, description: "", categoryId: "foreign-category" },
    };
    await expectLedger(saveNetEvent(ctx, { eventDate: "2026-10-01", legs: [malformed as never] }), "invalid_input",
      "A payable leg must either use an existing payable or create a new one, not both");
  });

  test("ledger error contract preserves representative core messages and ForbiddenError", () => fixture(async f => {
    const r = await relationalFixture(f);
    const metadata = await import("./metadata");
    const { linkPayeesToPerson } = await import("./person-links");
    const { runChange } = await import("./store");
    const { runRelationalChange } = await import("./relational-store");
    await expectLedger(f.editTransactionFields(f.app, { kind: "", edits: [] }), "invalid_input", "Invalid transaction edits.");
    await expectLedger(f.setPayeeDefault(f.app, { counterpartyId: "", categoryId: null, guard: {} }), "invalid_input", "Pick a payee and a category.");
    await expectLedger(r.splits.createSplit(f.app, {
      ...r.splitInput, yourSharePaise: 4000,
      participants: [{ personName: "Asha", expectedAmountPaise: 3000 }, { personName: "asha", expectedAmountPaise: 3000 }],
    }), "invalid_input", "Asha appears twice in this split. Each person may only have one share.");
    await expectLedger(r.owed.createOwedExpense(f.app, { ...r.expenseInput, amountPaise: 0 }), "invalid_input", "Amount must be positive");
    await expectLedger(r.owed.createOwedExpense(f.app, { ...r.expenseInput, sourceInflowTransactionId: f.ids[0] }), "invalid_input", "A source inflow must be a credit.");
    await expectLedger(r.net.saveNetEvent(f.app, { eventDate: "2026-10-01", legs: [] }), "invalid_input", "At least one non-zero leg is required");
    await r.settlements.writeOffParticipantShare(f.app, { splitParticipantId: r.share.id, note: null });
    await expectLedger(r.settlements.writeOffParticipantShare(f.app, { splitParticipantId: r.share.id, note: null }), "invalid_input", "Nothing outstanding on this share to forgive.");
    await expectLedger(metadata.renamePayee(f.app, { counterpartyId: f.payee, displayName: "", currentDisplayName: "Lunch" }), "invalid_input", "Use a nonblank display name of at most 200 characters.");
    await expectLedger(linkPayeesToPerson(f.app, []), "invalid_input", "Use 1–50 distinct payees with current-person guards.");
    await expectLedger(f.listPage(f.actor, { before: "invalid-cursor" }), "invalid_cursor", "Start with a new list_changes request.");
    await expectLedger(f.undoChange(f.app, crypto.randomUUID()), "not_found", "That change isn't available.");
    await expectLedger(runChange(f.app, { kind: "test", summary: "x".repeat(201) }, async () => ({ ops: [], result: {} })), "invalid_input", "Use a reason of at most 200 characters.");
    await expectLedger(runRelationalChange({ actor: f.actor, source: "mcp", tokenId: f.tokenId, label: "Test" }, "test", async () => ({ revalidate: false })), "invalid_input", "Use an 8–80 character idempotency key.");
    const splitError = await r.splits.createSplit(f.app, { ...r.splitInput, transactionId: f.otherId }).catch((error: unknown) => error);
    expect(splitError).toBeInstanceOf(ForbiddenError);
    expect(splitError).not.toBeInstanceOf(LedgerError);
    const netError = await r.net.deleteNetEvent(f.app, { netEventId: crypto.randomUUID() }).catch((error: unknown) => error);
    expect(netError).toBeInstanceOf(ForbiddenError);
    expect(netError).not.toBeInstanceOf(LedgerError);
  }), 120000);

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
  type Fixture = Awaited<ReturnType<typeof seed>>;
  async function relationalFixture(f: Fixture) {
    const splitCores = await import("./splits");
    const { runLedger } = await import("./run");
    const splits = { ...splitCores, recordSettlement: (ctx: WriteContext, input: Omit<import("./splits").RecordSettlementInput, "allocations"> & { allocations: import("./rules/settlement-policy").Allocation[] }) =>
      runLedger(splitCores.recordSettlement(ctx, { ...input, allocations: { kind: "explicit", rows: input.allocations } }), ctx.actor) };
    const cashCores = await import("./settlements");
    const settlements = { ...cashCores, recordCashSettlement: (ctx: WriteContext, input: import("./settlements").RecordCashSettlementInput) => runLedger(cashCores.recordCashSettlement(ctx, input), ctx.actor) };
    const netCores = await import("./net-events");
    const net = { ...netCores, saveNetEvent: (ctx: WriteContext, input: Parameters<typeof netCores.saveNetEvent>[1]) => runLedger(netCores.saveNetEvent(ctx, input), ctx.actor) };
    const owed = await import("./owed-expenses");
    const { relationalSnapshot } = await import("./relational-store");
    // The snapshot is one atomic SELECT; it needs no extra BEGIN/COMMIT.
    const snapshot = async () => [...(await relationalSnapshot(f.db, f.app)).entries()];
    await f.db
      .update(f.schema.transactions)
      .set({ drCr: "credit", amountPaise: 4000 })
      .where(eq(f.schema.transactions.id, f.ids[1]));
    const splitInput = {
      transactionId: f.ids[0],
      totalPaise: 10000,
      yourSharePaise: 4000,
      note: "original split",
      participants: [{ personName: "Kiran", expectedAmountPaise: 6000 }],
    };
    await splits.createSplit(f.app, splitInput);
    const [split] = await f.db
      .select()
      .from(f.schema.splits)
      .where(eq(f.schema.splits.transactionId, f.ids[0]));
    const [share] = await f.db
      .select()
      .from(f.schema.splitParticipants)
      .where(eq(f.schema.splitParticipants.splitId, split.id));
    const bankInput = {
      inflowTransactionId: f.ids[1],
      allocations: [{ splitParticipantId: share.id, amountPaise: 1000 }],
      residual: {
        kind: "owed_back" as const,
        personName: "Kiran",
        note: "overpaid",
      },
    };
    const expenseInput = {
      personName: "Arjun",
      incurredDate: "2026-10-03",
      amountPaise: 5000,
      description: "Dinner",
      categoryId: f.food,
      note: " original ",
    };
    const netInput = {
      eventDate: "2026-10-04",
      inflowTransactionId: f.ids[1],
      note: " net ",
      legs: [
        {
          kind: "receivable" as const,
          splitParticipantId: share.id,
          amountPaise: 4000,
          method: "bank" as const,
        },
        {
          kind: "receivable" as const,
          splitParticipantId: share.id,
          amountPaise: 1000,
          method: "offset" as const,
        },
        {
          kind: "payable" as const,
          newPayable: { ...expenseInput, amountPaise: 1000 },
          amountPaise: 1000,
          method: "offset" as const,
        },
      ],
    };
    const moveShare = () =>
      f.db
        .update(f.schema.splitParticipants)
        .set({ expectedAmountPaise: 6001 })
        .where(eq(f.schema.splitParticipants.id, share.id));
    return {
      splits,
      settlements,
      net,
      owed,
      snapshot,
      splitInput,
      split,
      share,
      bankInput,
      expenseInput,
      netInput,
      moveShare,
    };
  }
  test("Effect relational transaction rolls back failure/interruption and replays idempotently", () => fixture(async f => {
    const { Effect, Exit } = await import("effect");
    const { Db } = await import("./services");
    const { runRelationalChangeEffect } = await import("./relational-store");
    const run = <A, E>(effect: import("effect").Effect.Effect<A, E, import("./services").Db>) =>
      Effect.runPromiseExit(effect.pipe(Effect.provideService(Db, f.db)));
    const before = await f.db.select().from(f.schema.ledgerChanges).where(eq(f.schema.ledgerChanges.userId, f.actor.userId));
    for (const interrupt of [false, true]) {
      const exit = await run(runRelationalChangeEffect(f.app, "proof", (tx) => Effect.gen(function* () {
        yield* Effect.promise(() => tx.update(f.schema.transactions).set({ residualDisposition: "kept", residualAcknowledgedPaise: 100 }).where(eq(f.schema.transactions.id, f.ids[1])));
        if (interrupt) return yield* Effect.interrupt;
        return yield* new LedgerError({ code: "invalid_input", message: "proof" });
      })));
      expect(Exit.isFailure(exit)).toBe(true);
      const [row] = await f.db.select().from(f.schema.transactions).where(eq(f.schema.transactions.id, f.ids[1]));
      expect(row.residualDisposition).toBeNull();
      expect(await f.db.select().from(f.schema.ledgerChanges).where(eq(f.schema.ledgerChanges.userId, f.actor.userId))).toEqual(before);
    }
    const ctx = f.mcp("effect-proof-replay");
    const work = (tx: import("./store").LedgerTx) => Effect.gen(function* () {
      yield* Effect.promise(() => tx.update(f.schema.transactions).set({ residualDisposition: "kept", residualAcknowledgedPaise: 100 }).where(eq(f.schema.transactions.id, f.ids[1])));
      return { revalidate: true, value: 123 };
    });
    const first = await run(runRelationalChangeEffect(ctx, "proof", work));
    expect(Exit.isSuccess(first)).toBe(true);
    const replay = await run(runRelationalChangeEffect(ctx, "proof", () => Effect.die("must not run")));
    expect(Exit.isSuccess(replay) && replay.value.replayed).toBe(true);
    const conflict = await run(runRelationalChangeEffect({ ...ctx, idempotency: { ...ctx.idempotency!, requestHash: "different" } }, "proof", work));
    expect(Exit.isFailure(conflict)).toBe(true);
    if (Exit.isFailure(conflict)) expect(String(conflict.cause)).toContain("different request");
  }));
  const relationalCases = [
    "create_split",
    "delete_split",
    "record_settlement",
    "clear_settlement",
    "record_cash_settlement",
    "delete_cash_settlement",
    "write_off_participant_share",
    "undo_write_off",
    "save_net_event",
    "delete_net_event",
    "create_owed_expense",
    "update_owed_expense",
    "delete_owed_expense",
  ] as const;
  async function relationalCase(
    f: Fixture,
    kind: (typeof relationalCases)[number],
  ) {
    const r = await relationalFixture(f);
    const moveShare = async () => {
      await r.moveShare();
    };
    switch (kind) {
      case "create_split": {
        await r.splits.deleteSplit(f.app, { transactionId: f.ids[0] });
        const input = {
          ...r.splitInput,
          participants: [
            { personName: "New Person", expectedAmountPaise: 6000 },
          ],
        };
        return {
          ...r,
          run: (ctx: WriteContext) => r.splits.createSplit(ctx, input),
          move: async () => {
            await f.db
              .update(f.schema.splits)
              .set({ note: "moved" })
              .where(eq(f.schema.splits.transactionId, f.ids[0]));
          },
        };
      }
      case "delete_split": {
        await r.splits.recordSettlement(f.app, r.bankInput);
        await r.settlements.recordCashSettlement(f.app, {
          splitParticipantId: r.share.id,
          amountPaise: 1000,
          note: "cash",
        });
        return {
          ...r,
          run: (ctx: WriteContext) =>
            r.splits.deleteSplit(ctx, { transactionId: f.ids[0] }),
          move: async () => {
            await r.splits.createSplit(f.app, r.splitInput);
          },
        };
      }
      case "record_settlement":
        return {
          ...r,
          run: (ctx: WriteContext) =>
            r.splits.recordSettlement(ctx, r.bankInput),
          move: moveShare,
        };
      case "clear_settlement": {
        await r.splits.recordSettlement(f.app, r.bankInput);
        return {
          ...r,
          run: (ctx: WriteContext) =>
            r.splits.clearSettlement(ctx, { inflowTransactionId: f.ids[1] }),
          move: moveShare,
        };
      }
      case "record_cash_settlement":
        return {
          ...r,
          run: (ctx: WriteContext) =>
            r.settlements.recordCashSettlement(ctx, {
              splitParticipantId: r.share.id,
              amountPaise: 1234,
              note: " cash ",
            }),
          move: moveShare,
        };
      case "delete_cash_settlement": {
        await r.settlements.recordCashSettlement(f.app, {
          splitParticipantId: r.share.id,
          amountPaise: 1000,
          note: "cash",
        });
        const [row] = await f.db
          .select()
          .from(f.schema.settlements)
          .where(eq(f.schema.settlements.splitParticipantId, r.share.id));
        return {
          ...r,
          run: (ctx: WriteContext) =>
            r.settlements.deleteCashSettlement(ctx, { settlementId: row.id }),
          move: moveShare,
        };
      }
      case "write_off_participant_share":
        return {
          ...r,
          run: (ctx: WriteContext) =>
            r.settlements.writeOffParticipantShare(ctx, {
              splitParticipantId: r.share.id,
              note: " forgiven ",
            }),
          move: moveShare,
        };
      case "undo_write_off": {
        await r.settlements.writeOffParticipantShare(f.app, {
          splitParticipantId: r.share.id,
          note: "forgiven",
        });
        const [row] = await f.db
          .select()
          .from(f.schema.settlements)
          .where(eq(f.schema.settlements.splitParticipantId, r.share.id));
        return {
          ...r,
          run: (ctx: WriteContext) =>
            r.settlements.undoWriteOff(ctx, { settlementId: row.id }),
          move: moveShare,
        };
      }
      case "save_net_event":
        return {
          ...r,
          run: (ctx: WriteContext) => r.net.saveNetEvent(ctx, r.netInput),
          move: moveShare,
        };
      case "delete_net_event": {
        const created = await r.net.saveNetEvent(f.app, r.netInput);
        return {
          ...r,
          run: (ctx: WriteContext) =>
            r.net.deleteNetEvent(ctx, {
              netEventId: created.value.netEventId,
            }),
          move: moveShare,
        };
      }
      case "create_owed_expense":
        return {
          ...r,
          run: (ctx: WriteContext) =>
            r.owed.createOwedExpense(ctx, r.expenseInput),
          move: async () => {
            await f.db
              .update(f.schema.owedExpenses)
              .set({ description: "moved" })
              .where(eq(f.schema.owedExpenses.userId, f.actor.userId));
          },
        };
      case "update_owed_expense": {
        const created = await r.owed.createOwedExpense(f.app, r.expenseInput);
        return {
          ...r,
          run: (ctx: WriteContext) =>
            r.owed.updateOwedExpense(ctx, {
              id: created.value,
              personName: "New Person",
              amountPaise: 7000,
              note: "updated",
            }),
          move: async () => {
            await f.db
              .update(f.schema.owedExpenses)
              .set({ description: "moved" })
              .where(eq(f.schema.owedExpenses.id, created.value));
          },
        };
      }
      case "delete_owed_expense": {
        const created = await r.owed.createOwedExpense(f.app, r.expenseInput);
        const [expense] = await f.db
          .select()
          .from(f.schema.owedExpenses)
          .where(eq(f.schema.owedExpenses.id, created.value));
        await f.db
          .insert(f.schema.settlements)
          .values({
            owedExpenseId: expense.id,
            amountPaise: 1000,
            method: "cash",
            note: "owed repayment",
          });
        return {
          ...r,
          run: (ctx: WriteContext) =>
            r.owed.deleteOwedExpense(ctx, { id: expense.id }),
          move: async () => {
            await f.db
              .insert(f.schema.owedExpenses)
              .values({ ...expense, description: "moved" });
          },
        };
      }
    }
  }
  for (const kind of relationalCases) {
    test(
      `${kind}: tenant refusal, log, exact undo, undo of undo and stale whole-change refusal`,
      () =>
        fixture(async (f) => {
          const r = await relationalCase(f, kind);
          const before = await r.snapshot();
          await expect(
            r.run({
              actor: { userId: f.otherUser, accountId: f.otherAccount },
              source: "app",
            }),
          ).rejects.toThrow();
          expect(await r.snapshot()).toEqual(before);
          const result = await r.run(f.app);
          expect(result.changeId).toBeTruthy();
          const logged = (await f.listChanges(f.actor)).find(
            (c) => c.id === result.changeId,
          );
          expect(logged?.kind).toBe(kind);
          expect(logged?.summary).toBeTruthy();
          const after = await r.snapshot();
          expect(after).not.toEqual(before);
          const undone = await f.undoChange(f.app, result.changeId!);
          expect(undone.stale).toBeUndefined();
          expect(await r.snapshot()).toEqual(before);
          const redone = await f.undoChange(f.app, undone.changeId!);
          expect(redone.stale).toBeUndefined();
          expect(await r.snapshot()).toEqual(after);
          await r.move();
          const moved = await r.snapshot();
          const stale = await f.undoChange(f.app, redone.changeId!);
          expect(stale.stale?.length).toBeGreaterThan(0);
          expect(await r.snapshot()).toEqual(moved);
        }),
      60000,
    );
    test(
      `${kind}: MCP replay after state moves and conflict before writing`,
      () =>
        fixture(async (f) => {
          const r = await relationalCase(f, kind);
          const ctx = f.mcp(`phase3_${kind}`);
          const first = await r.run(ctx);
          await r.move();
          const moved = await r.snapshot();
          const replay = await r.run(ctx);
          expect(replay.replayed).toBe(true);
          expect(replay.changeId).toBe(first.changeId);
          expect(replay.value).toEqual(first.value);
          expect(await r.snapshot()).toEqual(moved);
          await expect(
            r.owed.createOwedExpense(f.mcp(ctx.idempotency!.key, { different: true }), {
              ...r.expenseInput,
              description: "conflicting request",
            }),
          ).rejects.toMatchObject({ code: "idempotency_conflict" });
          expect(await r.snapshot()).toEqual(moved);
        }),
      60000,
    );
  }
  test(
    "relational guards preserve assistant contracts, settled-share edits and residual repayability",
    () =>
      fixture(async (f) => {
        const r = await relationalFixture(f);
        await expect(
          r.splits.createSplit(f.app, {
            ...r.splitInput,
            expectNoExistingSplit: true,
          }),
        ).rejects.toThrow("already has a split");
        await r.splits.recordSettlement(f.app, r.bankInput);
        await expect(
          r.splits.deleteSplit(f.app, {
            transactionId: f.ids[0],
            expectNoSettlements: true,
          }),
        ).rejects.toThrow("Money was settled");
        await expect(
          r.splits.createSplit(f.app, { ...r.splitInput, participants: [] }),
        ).rejects.toThrow();
        await expect(
          r.splits.recordSettlement(f.app, {
            ...r.bankInput,
            allocations: [
              { splitParticipantId: r.share.id, amountPaise: 7000 },
            ],
          }),
        ).rejects.toThrow();
        const [payable] = await f.db
          .select()
          .from(f.schema.owedExpenses)
          .where(eq(f.schema.owedExpenses.sourceInflowTransactionId, f.ids[1]));
        await f.db
          .insert(f.schema.settlements)
          .values({
            owedExpenseId: payable.id,
            amountPaise: 1,
            method: "offset",
          });
        const before = await r.snapshot();
        await expect(
          r.splits.clearSettlement(f.app, { inflowTransactionId: f.ids[1] }),
        ).rejects.toThrow();
        expect(await r.snapshot()).toEqual(before);
      }),
    60000,
  );
  test(
    "new settlement prevents undoing split creation; deleted share prevents restoring settlement",
    () =>
      fixture(async (f) => {
        const r = await relationalFixture(f);
        const ctx = f.mcp("guard_split_create");
        await r.splits.deleteSplit(f.app, { transactionId: f.ids[0] });
        const created = await r.splits.createSplit(ctx, r.splitInput);
        const [sp] = await f.db
          .select()
          .from(f.schema.splitParticipants)
          .innerJoin(
            f.schema.splits,
            eq(f.schema.splitParticipants.splitId, f.schema.splits.id),
          )
          .where(eq(f.schema.splits.transactionId, f.ids[0]));
        const shareId = sp.split_participant.id;
        await r.settlements.recordCashSettlement(f.app, {
          splitParticipantId: shareId,
          amountPaise: 100,
          note: null,
        });
        expect(
          (await f.undoChange(f.app, created.changeId!)).stale?.length,
        ).toBeGreaterThan(0);
        const [settlement] = await f.db
          .select()
          .from(f.schema.settlements)
          .where(eq(f.schema.settlements.splitParticipantId, shareId));
        const deleted = await r.settlements.deleteCashSettlement(f.app, {
          settlementId: settlement.id,
        });
        await r.splits.deleteSplit(f.app, { transactionId: f.ids[0] });
        expect(
          (await f.undoChange(f.app, deleted.changeId!)).stale?.length,
        ).toBeGreaterThan(0);
      }),
    60000,
  );
  test(
    "net duplicate guard, cash refusal, writeoff methods, owed validation and failed keys",
    () =>
      fixture(async (f) => {
        const r = await relationalFixture(f);
        await r.net.saveNetEvent(f.app, r.netInput);
        await expect(r.net.saveNetEvent(f.app, r.netInput)).rejects.toThrow(
          "already net settled",
        );
        const before = await r.snapshot();
        await expect(r.settlements.recordCashSettlement(f.app, { splitParticipantId: r.share.id, amountPaise: 0, note: null })).rejects.toMatchObject({ code: "invalid_amount" });
        await expect(
          r.settlements.undoWriteOff(f.app, {
            settlementId: crypto.randomUUID(),
          }),
        ).rejects.toThrow();
        await expect(
          r.owed.updateOwedExpense(f.app, {
            id: crypto.randomUUID(),
            amountPaise: -1,
          }),
        ).rejects.toThrow();
        const key = f.mcp("failed_owed_key");
        await expect(
          r.owed.createOwedExpense(key, { ...r.expenseInput, amountPaise: -1 }),
        ).rejects.toThrow("Amount must be positive");
        expect(await r.snapshot()).toEqual(before);
        expect(
          (await r.owed.createOwedExpense(key, r.expenseInput)).changeId,
        ).toBeTruthy();
        const noKey: WriteContext = {
          actor: f.actor,
          source: "mcp",
          tokenId: f.tokenId,
          label: "Test",
        };
        await expect(
          r.owed.createOwedExpense(noKey, r.expenseInput),
        ).rejects.toMatchObject({ code: "invalid_input" });
      }),
    60000,
  );
  test(
    "concurrent guarded splits and bank allocations cannot double-spend",
    () =>
      fixture(async (f) => {
        const r = await relationalFixture(f);
        await r.splits.deleteSplit(f.app, { transactionId: f.ids[0] });
        const results = await Promise.allSettled(
          [1, 2].map(() =>
            r.splits.createSplit(f.app, {
              ...r.splitInput,
              expectNoExistingSplit: true,
            }),
          ),
        );
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        const [sp] = await f.db
          .select()
          .from(f.schema.splitParticipants)
          .innerJoin(
            f.schema.splits,
            eq(f.schema.splitParticipants.splitId, f.schema.splits.id),
          )
          .where(eq(f.schema.splits.transactionId, f.ids[0]));
        await Promise.allSettled(
          [1, 2].map(() =>
            r.settlements.recordCashSettlement(f.app, {
              splitParticipantId: sp.split_participant.id,
              amountPaise: 5000,
              note: null,
            }),
          ),
        );
        const rows = await f.db
          .select()
          .from(f.schema.settlements)
          .where(
            eq(
              f.schema.settlements.splitParticipantId,
              sp.split_participant.id,
            ),
          );
        expect(
          rows.reduce((sum, row) => sum + Number(row.amountPaise), 0),
        ).toBe(5000);
      }),
    60000,
  );
  test("split edit keeps settled participant ids and refuses a renamed or foreign participant", () => fixture(async f => {
    const r = await relationalFixture(f);
    await r.settlements.recordCashSettlement(f.app, { splitParticipantId: r.share.id, amountPaise: 1000, note: null });
    const before = await r.snapshot();
    await expect(r.splits.createSplit(f.app, { ...r.splitInput, participants: [{ id: r.share.id, personName: "Different Person", expectedAmountPaise: 6000 }] })).rejects.toThrow();
    await expect(r.splits.createSplit(f.app, { ...r.splitInput, participants: [{ id: crypto.randomUUID(), personName: "Kiran", expectedAmountPaise: 6000 }] })).rejects.toThrow("doesn't belong");
    expect(await r.snapshot()).toEqual(before);
    const edited = await r.splits.createSplit(f.app, { ...r.splitInput, yourSharePaise: 3000, participants: [{ id: r.share.id, personName: "Kiran", expectedAmountPaise: 7000 }] });
    const [share] = await f.db.select().from(f.schema.splitParticipants).where(eq(f.schema.splitParticipants.id, r.share.id));
    expect(share.expectedAmountPaise).toBe(7000);
    expect((await f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.splitParticipantId, r.share.id)))).toHaveLength(1);
    await f.undoChange(f.app, edited.changeId!);
    expect(await r.snapshot()).toEqual(before);
  }), 60000);
  test("guided cash plus offsets is atomic, uses the server date and supports exact undo", () => fixture(async f => {
    const r = await relationalFixture(f);
    const expense = await r.owed.createOwedExpense(f.app, {...r.expenseInput, amountPaise: 18500});
    const before = await r.snapshot();
    const legs = [
      {kind: "receivable" as const, splitParticipantId: r.share.id, amountPaise: 6000, method: "offset" as const, expectedOutstandingPaise: 6000},
      {kind: "payable" as const, owedExpenseId: expense.value, amountPaise: 12500, method: "cash" as const, expectedOutstandingPaise: 18500},
      {kind: "payable" as const, owedExpenseId: expense.value, amountPaise: 6000, method: "offset" as const, expectedOutstandingPaise: 18500},
    ];
    const saved = await r.net.saveNetEvent(f.app, { legs});
    const rows = await f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.netEventId,saved.value.netEventId));
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => row.method === "cash").map(row=>Number(row.amountPaise))).toEqual([12500]);
    expect(rows.every(row => row.inflowTransactionId === null)).toBe(true);
    const [event] = await f.db.select().from(f.schema.netEvents).where(eq(f.schema.netEvents.id,saved.value.netEventId));
    expect(event.eventDate).toBe(indiaTodayIso());
    const after = await r.snapshot();
    await expect(r.net.saveNetEvent(f.app,{ legs})).rejects.toMatchObject({code:"stale"});
    expect(await r.snapshot()).toEqual(after);
    const undone = await f.undoChange(f.app,saved.changeId!);
    expect(await r.snapshot()).toEqual(before);
    await f.undoChange(f.app, undone.changeId!);
    expect(await r.snapshot()).toEqual(after);
  }),60000);

  test("guided settlements reject changed balances, allocated bank sources and wrong directions without writes", () => fixture(async f => {
    const r = await relationalFixture(f);
    const before = await r.snapshot();
    await expect(r.net.saveNetEvent(f.app,{...r.netInput, legs:r.netInput.legs.map(leg=>({...leg,...(leg.kind==="receivable"?{expectedOutstandingPaise:6001}:{})}))})).rejects.toMatchObject({code:"stale"});
    expect(await r.snapshot()).toEqual(before);
    await f.db.update(f.schema.transactions).set({drCr:"debit"}).where(eq(f.schema.transactions.id,f.ids[1]));
    await expect(r.net.saveNetEvent(f.app,r.netInput)).rejects.toThrow("wrong direction");
    await f.db.update(f.schema.transactions).set({drCr:"credit"}).where(eq(f.schema.transactions.id,f.ids[1]));
    await r.splits.recordSettlement(f.app,{inflowTransactionId:f.ids[1],allocations:[{splitParticipantId:r.share.id,amountPaise:1000}]});
    const allocated = await r.snapshot();
    await expect(r.net.saveNetEvent(f.app,r.netInput)).rejects.toMatchObject({code:"stale"});
    expect(await r.snapshot()).toEqual(allocated);
  }),60000);

  test("net guards reject cash dates, cash-bank mixtures, split outflows and conflicting previews atomically", () => fixture(async f => {
    const r = await relationalFixture(f);
    const cash = [{ kind: "receivable" as const, splitParticipantId: r.share.id, amountPaise: 1000, method: "cash" as const, expectedOutstandingPaise: 6000 }];
    const before = await r.snapshot();
    for (const eventDate of ["2000-01-01", "2099-01-01"]) {
      await expect(r.net.saveNetEvent(f.app, { eventDate, legs: cash })).rejects.toMatchObject({ code: "invalid_input" });
      expect(await r.snapshot()).toEqual(before);
    }
    await expect(r.net.saveNetEvent(f.app, { inflowTransactionId: f.ids[1], legs: cash })).rejects.toThrow("cannot also use a bank");
    await expect(r.net.saveNetEvent(f.app, { ...r.netInput, outflowTransactionId: f.ids[0] })).rejects.toThrow("already a split bill");
    await expect(r.net.saveNetEvent(f.app, { ...r.netInput, outflowTransactionId: f.ids[1] })).rejects.toThrow("wrong direction");
    await expect(r.net.saveNetEvent(f.app, { legs: [cash[0], { ...cash[0], expectedOutstandingPaise: 5000 }] })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await r.snapshot()).toEqual(before);
    const saved = await r.net.saveNetEvent(f.app, { eventDate: indiaTodayIso(), legs: cash });
    expect(saved.value.receipt.legs[0].leftPaise).toBe(5000);
  }), 60000);

  test("settlement payment read scopes accounts, payees and people independently", () => fixture(async f => {
    const { loadSettlementPaymentsForAccount } = await import("./read/settlement-payments");
    const foreignPerson = crypto.randomUUID(), foreignPayee = crypto.randomUUID();
    await f.db.insert(f.schema.persons).values({ id: foreignPerson, userId: f.otherUser, name: "Foreign Finch" });
    await f.db.insert(f.schema.counterparties).values({ id: foreignPayee, userId: f.otherUser, key: "foreign-finch", kind: "merchant", personId: foreignPerson });
    await f.db.update(f.schema.transactions).set({ counterpartyId: foreignPayee }).where(eq(f.schema.transactions.id, f.ids[1]));
    const rows = await loadSettlementPaymentsForAccount(f.actor);
    expect(rows.find(r => r.id === f.ids[1])?.personName).toBeNull();
    expect(rows.some(r => r.personName === "Foreign Finch")).toBe(false);
    expect(await loadSettlementPaymentsForAccount({ userId: f.otherUser, accountId: f.actor.accountId })).toEqual([]);
  }), 60000);

  test("net event edit replaces the event id and undo restores the exact prior event and legs", () => fixture(async f => {
    const r = await relationalFixture(f);
    const created = await r.net.saveNetEvent(f.app, r.netInput);
    const before = await r.snapshot();
    const edited = await r.net.saveNetEvent(f.app, { ...r.netInput, netEventId: created.value.netEventId, note: "edited" });
    expect(edited.value.netEventId).not.toBe(created.value.netEventId);
    await f.undoChange(f.app, edited.changeId!);
    expect(await r.snapshot()).toEqual(before);
    const createdExpense = await r.owed.createOwedExpense(f.app, r.expenseInput);
    const state = await r.snapshot();
    await expect(r.owed.updateOwedExpense(f.app, { id: createdExpense.value, amountPaise: -1 })).rejects.toThrow("Amount must be positive");
    expect(await r.snapshot()).toEqual(state);
  }), 60000);
  test("bank clearing keeps net-event legs and undo restores residual acknowledgements exactly", () => fixture(async f => {
    const r = await relationalFixture(f);
    await r.net.saveNetEvent(f.app, { eventDate: "2026-10-04", inflowTransactionId: f.ids[1], legs: [
      { kind: "receivable", splitParticipantId: r.share.id, amountPaise: 2000, method: "bank" },
      { kind: "receivable", splitParticipantId: r.share.id, amountPaise: 2000, method: "offset" },
    ] });
    await r.splits.recordSettlement(f.app, { ...r.bankInput, residual: { kind: "kept" } });
    expect((await f.read(f.ids[1])).residualAcknowledgedPaise).toBe(1000);
    const before = await r.snapshot();
    const cleared = await r.splits.clearSettlement(f.app, { inflowTransactionId: f.ids[1] });
    const remaining = await f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.splitParticipantId, r.share.id));
    expect(remaining).toHaveLength(2);
    expect(remaining.every(row => row.netEventId !== null)).toBe(true);
    expect((await f.read(f.ids[1])).residualAcknowledgedPaise).toBeNull();
    await f.undoChange(f.app, cleared.changeId!);
    expect(await r.snapshot()).toEqual(before);
    const deleted = await r.splits.deleteSplit(f.app, { transactionId: f.ids[0] });
    expect((await f.read(f.ids[1])).residualAcknowledgedPaise).toBeNull();
    await f.undoChange(f.app, deleted.changeId!);
    expect(await r.snapshot()).toEqual(before);
  }), 60000);
  test("MCP exact cash stores a receipt and cash/writeoff preserve refusals, methods and server dates", () => fixture(async f => {
    const r = await relationalFixture(f);
    const ctx = f.mcp("noop_cash_receipt");
    const input = { splitParticipantId: r.share.id, amountPaise: 0, note: null };
    await expect(r.settlements.recordCashSettlement(ctx, input)).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(r.settlements.recordCashSettlement(f.app, { ...input, amountPaise: 7000 })).rejects.toMatchObject({ code: "over_allocation" });
    const first = await r.settlements.recordCashSettlement(ctx, { ...input, amountPaise: 6000, note: " cash " });
    expect(first.value).toEqual({ appliedPaise: 6000, leftPaise: 0 });
    expect((await r.settlements.recordCashSettlement(ctx, { ...input, amountPaise: 6000, note: " cash " })).replayed).toBe(true);
    const [cash] = await f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.splitParticipantId, r.share.id));
    expect(cash.amountPaise).toBe(6000);
    expect(cash.method).toBe("cash");
    expect(cash.note).toBe("cash");
    expect(cash.createdAt).toBeInstanceOf(Date);
    await expect(r.settlements.undoWriteOff(f.app, { settlementId: cash.id })).rejects.toThrow("not a writeoff");
    await expect(r.settlements.writeOffParticipantShare(f.app, { splitParticipantId: r.share.id, note: null })).rejects.toThrow("Nothing outstanding");
    await r.settlements.deleteCashSettlement(f.app, { settlementId: cash.id });
    const forgiven = await r.settlements.writeOffParticipantShare(f.app, { splitParticipantId: r.share.id, note: " gift " });
    const [writeoff] = await f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.splitParticipantId, r.share.id));
    expect(writeoff.method).toBe("writeoff");
    expect(writeoff.amountPaise).toBe(6000);
    expect(writeoff.note).toBe("gift");
    expect(writeoff.inflowTransactionId).toBeNull();
    expect(forgiven.changeId).toBeTruthy();
  }), 60000);

  async function phase4Fixture(run: (f: Fixture, api: {
    call: (tool: import("@/lib/mcp/relational-schemas").RelationalTool, args: object) => Promise<Record<string, unknown>>;
    undo: (change: unknown, key: string) => Promise<Record<string, unknown>>;
    txRef: (id: string) => string; splitRev: (id: string) => Promise<string>; rev: (id: string) => Promise<string>;
    shareRef: (id: string) => string; owedRef: (id: string) => string;
  }) => Promise<void>) {
    return fixture(async f => {
      const { mcpWriteOps } = await import("@/lib/mcp/write-ops");
      const refs = await import("@/lib/mcp/refs");
      const previous = process.env.AUTH_SECRET;
      process.env.AUTH_SECRET = "phase4-adapter-secret";
      const key = refs.deriveMcpRefKey(process.env.AUTH_SECRET);
      const principal = { actor: f.actor, scope: "write" as const, tokenId: f.tokenId, label: "Phase 4 agent" };
      try {
        await run(f, {
          call: (tool, args) => mcpWriteOps.relational(principal, tool, args),
          undo: (change, idempotency_key) => mcpWriteOps.undo(principal, { change_id: String(change), idempotency_key }),
          txRef: id => refs.transactionRef(key, f.actor.userId, id),
          rev: async id => refs.transactionRev(refs.deriveMcpRevKey(process.env.AUTH_SECRET), f.actor.userId, id, await f.read(id)),
          splitRev: async id => {
            const { mcpReadOps } = await import("@/lib/mcp/read-ops");
            const { buildReadView } = await import("@/lib/mcp/model-view");
            const view = buildReadView(await mcpReadOps.readModel(f.actor), f.actor, key, refs.deriveMcpRevKey(process.env.AUTH_SECRET));
            return view.transactions.find(t => t.ref === refs.transactionRef(key, f.actor.userId, id))!.split_rev;
          },
          shareRef: id => refs.shareRef(key, f.actor.userId, f.actor.accountId, id),
          owedRef: id => refs.owedRef(key, f.actor.userId, f.actor.accountId, id),
        });
      } finally {
        if (previous === undefined) delete process.env.AUTH_SECRET;
        else process.env.AUTH_SECRET = previous;
      }
    });
  }
  for (const operation of ["delete_split", "create_split"] as const) {
    test(`stale split_rev refuses ${operation} after an app edit; a fresh revision works`, () => phase4Fixture(async (f, api) => {
      const r = await relationalFixture(f);
      const { relationalSnapshot } = await import("./relational-store");
      const oldSplitRev = await api.splitRev(f.ids[0]);
      const oldRelations = await relationalSnapshot(f.db, f.app);
      const rev = await api.rev(f.ids[0]);
      await r.splits.createSplit(f.app, { ...r.splitInput, yourSharePaise: 3000,
        participants: [{ id: r.share.id, personName: "Kiran", expectedAmountPaise: 7000 }] });
      expect(await api.rev(f.ids[0])).toBe(rev);
      const current = await api.splitRev(f.ids[0]);
      expect(current).not.toBe(oldSplitRev);
      const input = { ref: api.txRef(f.ids[0]), rev, split_rev: oldSplitRev,
        ...(operation === "create_split" ? { replace_existing: true, equal: true, participants: [{ person: "Kiran" }] } : {}),
        idempotency_key: `stale-${operation}` };
      expect(await api.call(operation, input)).toMatchObject({ applied: false, errors: [{ code: "stale", current_split_rev: current }] });
      // Also prove the core refuses an adapter snapshot captured before the edit,
      // with current_split_rev taking priority over the generic snapshot guard.
      const ctx = { ...f.mcp(`locked-${operation}`), expectedRelations: oldRelations, splitRevs: { [f.ids[0]]: oldSplitRev } };
      const locked = operation === "delete_split"
        ? r.splits.deleteSplit(ctx, { transactionId: f.ids[0], expectNoSettlements: true })
        : r.splits.createSplit(ctx, r.splitInput);
      await expect(locked).rejects.toMatchObject({ code: "stale", current_split_rev: current });
      expect(await api.splitRev(f.ids[0])).toBe(current);
      expect((await api.call(operation, { ...input, split_rev: current, idempotency_key: `fresh-${operation}` })).applied).toBe(true);
      if (operation === "delete_split") expect(await api.splitRev(f.ids[0])).toBe("none");
      else expect(await api.splitRev(f.ids[0])).not.toBe(current);
    }));
  }

  test("sourced owed updates enforce the source cap for MCP and app, excluding the current expense", () => phase4Fixture(async (f, api) => {
    const { createOwedExpense, updateOwedExpense } = await import("./owed-expenses");
    await f.db.update(f.schema.transactions).set({ drCr: "credit" }).where(eq(f.schema.transactions.id, f.ids[1]));
    const created = await createOwedExpense(f.app, { personName: "Kiran", incurredDate: "2026-10-01", description: "Overpayment", amountPaise: 10000, sourceInflowTransactionId: f.ids[1] });
    const input = { owed_ref: api.owedRef(created.value), amount: "200", idempotency_key: "owed-over-capacity" };
    expect(await api.call("update_owed_expense", input)).toMatchObject({ applied: false, errors: [{ code: "invalid_input", message: "Source inflow is already explained or has insufficient unallocated money." }] });
    await expect(updateOwedExpense(f.app, { id: created.value, amountPaise: 20000 })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await api.call("update_owed_expense", { ...input, amount: "90", idempotency_key: "owed-within-capacity" })).applied).toBe(true);
    await updateOwedExpense(f.app, { id: created.value, amountPaise: 10000 });
    const [row] = await f.db.select().from(f.schema.owedExpenses).where(eq(f.schema.owedExpenses.id, created.value));
    expect(row.amountPaise).toBe(10000);
  }));

  test("sourced owed updates subtract existing bank allocations from source capacity", () => fixture(async f => {
    const r = await relationalFixture(f);
    await r.splits.recordSettlement(f.app, r.bankInput);
    const [owed] = await f.db.select().from(f.schema.owedExpenses).where(eq(f.schema.owedExpenses.sourceInflowTransactionId, f.ids[1]));
    await expect(r.owed.updateOwedExpense(f.app, { id: owed.id, amountPaise: 3001 })).rejects.toMatchObject({ code: "invalid_input" });
    await r.owed.updateOwedExpense(f.app, { id: owed.id, amountPaise: 2500 });
    await r.owed.updateOwedExpense(f.app, { id: owed.id, amountPaise: 3000 });
  }));

  test("agents mark a credit's leftover in one call: owed back, replay, one-time, undo", () => phase4Fixture(async (f, api) => {
    await f.db.update(f.schema.transactions).set({ drCr: "credit", amountPaise: 8000 }).where(eq(f.schema.transactions.id, f.ids[1]));
    const created = await api.call("create_split", { ref: api.txRef(f.ids[0]), rev: await api.rev(f.ids[0]), participants: [{ person: "Kiran", create_person: true }], equal: true, idempotency_key: "left-split-1" });
    expect(created.applied).toBe(true);
    const input = { inflow_ref: api.txRef(f.ids[1]), person: "Kiran", leftover: { kind: "owed_back", note: "Overpaid for lunch" }, idempotency_key: "left-owed-1" };
    const marked = await api.call("record_settlement", input);
    expect(marked).toMatchObject({ applied: true, unallocated: "0.00", leftover: { kind: "owed_back", amount: "30.00" }, allocations: [{ person: "Kiran", amount: "50.00", left: "0.00" }] });
    expect(marked.summary).toContain("₹30.00 marked owed back");
    const owedRows = () => f.db.select().from(f.schema.owedExpenses).where(eq(f.schema.owedExpenses.sourceInflowTransactionId, f.ids[1]));
    expect(await owedRows()).toMatchObject([{ personName: "Kiran", amountPaise: 3000, note: "Overpaid for lunch", description: "Overpayment from Kiran" }]);
    expect(await api.call("record_settlement", input)).toMatchObject({ applied: true, replayed: true, change_id: marked.change_id });
    expect(await owedRows()).toHaveLength(1);
    expect(await api.call("record_settlement", { inflow_ref: api.txRef(f.ids[1]), person: "Kiran", allocations: [], leftover: { kind: "kept" }, idempotency_key: "left-again-1" }))
      .toMatchObject({ applied: false, errors: [{ code: "explained_inflow" }] });
    const undone = await api.undo(marked.change_id, "left-undo-1");
    expect(undone.applied).toBe(true);
    expect(await owedRows()).toHaveLength(0);
    expect(await f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.inflowTransactionId, f.ids[1]))).toHaveLength(0);
    expect((await api.undo(undone.change_id, "left-redo-1")).applied).toBe(true);
    expect(await owedRows()).toMatchObject([{ amountPaise: 3000 }]);
  }));
  test("agents can mark a leftover afterwards, and every refusal writes nothing", () => phase4Fixture(async (f, api) => {
    await f.db.update(f.schema.transactions).set({ drCr: "credit", amountPaise: 8000 }).where(eq(f.schema.transactions.id, f.ids[1]));
    await api.call("create_split", { ref: api.txRef(f.ids[0]), rev: await api.rev(f.ids[0]), participants: [{ person: "Kiran", create_person: true }], equal: true, idempotency_key: "after-split-1" });
    const inflow = api.txRef(f.ids[1]);
    expect(await api.call("record_settlement", { inflow_ref: inflow, person: "Kiran", allocations: [], idempotency_key: "after-empty-1" }))
      .toMatchObject({ applied: false, errors: [{ code: "invalid_input", message: "Give at least one allocation, or a leftover to mark." }] });
    expect(await api.call("record_settlement", { inflow_ref: inflow, person: "Nobody Known", allocations: [], leftover: { kind: "kept" }, idempotency_key: "after-unknown-1" }))
      .toMatchObject({ applied: false, errors: [{ code: "unknown_person" }] });
    expect(await api.call("record_settlement", { inflow_ref: inflow, person: "Kiran", idempotency_key: "after-first-1" })).toMatchObject({ applied: true, unallocated: "30.00", leftover: null });
    const credit = async () => (await f.db.select().from(f.schema.transactions).where(eq(f.schema.transactions.id, f.ids[1])))[0];
    const marked = await api.call("record_settlement", { inflow_ref: inflow, person: "Kiran", allocations: [], leftover: { kind: "kept" }, idempotency_key: "after-kept-1" });
    expect(marked).toMatchObject({ applied: true, unallocated: "0.00", leftover: { kind: "kept", amount: "30.00" }, allocations: [] });
    expect(await credit()).toMatchObject({ residualDisposition: "kept", residualAcknowledgedPaise: 3000 });
    const settlements = () => f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.inflowTransactionId, f.ids[1]));
    expect(await settlements()).toHaveLength(1);
    expect((await api.undo(marked.change_id, "after-undo-1")).applied).toBe(true);
    expect(await credit()).toMatchObject({ residualDisposition: null, residualAcknowledgedPaise: null });
    expect(await settlements()).toHaveLength(1);
    await f.db.update(f.schema.transactions).set({ amountPaise: 5000 }).where(eq(f.schema.transactions.id, f.ids[1]));
    expect(await api.call("record_settlement", { inflow_ref: inflow, person: "Kiran", allocations: [], leftover: { kind: "written_off" }, idempotency_key: "after-none-1" }))
      .toMatchObject({ applied: false, errors: [{ code: "fully_allocated" }] });
    expect(await credit()).toMatchObject({ residualDisposition: null });
  }));
  test("a leftover is refused when the allocations in the same call use the whole credit", () => phase4Fixture(async (f, api) => {
    await f.db.update(f.schema.transactions).set({ drCr: "credit", amountPaise: 5000 }).where(eq(f.schema.transactions.id, f.ids[1]));
    await api.call("create_split", { ref: api.txRef(f.ids[0]), rev: await api.rev(f.ids[0]), participants: [{ person: "Kiran", create_person: true }], equal: true, idempotency_key: "whole-split-1" });
    expect(await api.call("record_settlement", { inflow_ref: api.txRef(f.ids[1]), person: "Kiran", leftover: { kind: "kept" }, idempotency_key: "whole-left-1" }))
      .toMatchObject({ applied: false, errors: [{ code: "fully_allocated", message: "Nothing is left over on this payment after these allocations." }] });
    expect(await f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.inflowTransactionId, f.ids[1]))).toHaveLength(0);
  }));
  test("kept and written-off credits are not unlinked inflows in balances or period review", () => phase4Fixture(async (f, api) => {
    const r = await relationalFixture(f);
    const { mcpReadOps } = await import("@/lib/mcp/read-ops");
    const { buildReadView, getOpenBalances } = await import("@/lib/mcp/model-view");
    const { reviewPeriod } = await import("@/lib/mcp/period-review");
    const { deriveMcpRefKey, deriveMcpRevKey } = await import("@/lib/mcp/refs");
    const { linkPayeesToPerson } = await import("./person-links");
    await linkPayeesToPerson(f.app, [{ counterpartyId: f.payee, person: "Kiran", currentPerson: null }]);
    const load = async () => buildReadView(await mcpReadOps.readModel(f.actor), f.actor,
      deriveMcpRefKey(process.env.AUTH_SECRET), deriveMcpRevKey(process.env.AUTH_SECRET));
    const ref = api.txRef(f.ids[1]);
    expect(getOpenBalances(await load(), "Kiran").people[0].unlinked_inflows.map(t => t.txn_ref)).toContain(ref);
    for (const kind of ["kept", "written_off"] as const) {
      // No allocations is the regression: there is no settlement row for SQL to find.
      await r.splits.recordSettlement(f.app, { inflowTransactionId: f.ids[1], allocations: [], residual: { kind } });
      const view = await load();
      expect((await f.read(f.ids[1])).residualAcknowledgedPaise).toBe(4000);
      expect(view.linkedInflowRefs.has(ref)).toBe(true);
      expect(getOpenBalances(view, "Kiran").people[0].unlinked_inflows).toEqual([]);
      expect(reviewPeriod(view, { month: "2026-10" }).unlinked_inflows.rows).toEqual([]);
    }
    await r.splits.clearSettlement(f.app, { inflowTransactionId: f.ids[1] });
    expect(getOpenBalances(await load(), "Kiran").people[0].unlinked_inflows).toHaveLength(1);
    await r.splits.recordSettlement(f.app, { inflowTransactionId: f.ids[1], allocations: r.bankInput.allocations, residual: { kind: "kept" } });
    expect((await f.read(f.ids[1])).residualAcknowledgedPaise).toBe(3000);
    expect(reviewPeriod(await load(), {}).unlinked_inflows.count).toBe(0);
  }));

  test("phase4 MCP split, oldest-first partials, exact replay/conflict and settlement then split undo", () => phase4Fixture(async (f, api) => {
    const { RelationalOutput } = await import("@/lib/mcp/relational-schemas");
    const { Schema } = await import("effect");
    await f.db.update(f.schema.transactions).set({ drCr: "credit", amountPaise: 6000 }).where(eq(f.schema.transactions.id, f.ids[1]));
    const ref = api.txRef(f.ids[0]);
    const input = { ref, rev: await api.rev(f.ids[0]), participants: [{ person: "Kiran", create_person: true }], equal: true, idempotency_key: "p4-create-split", reason: "Lunch split" };
    const created = await api.call("create_split", input);
    expect(created.applied).toBe(true); expect(Schema.is(RelationalOutput)(created)).toBe(true);
    expect((created.refs as string[]).some(ref => ref.startsWith("shr_"))).toBe(true);
    const bill2 = crypto.randomUUID();
    await f.db.insert(f.schema.transactions).values({ id: bill2, accountId: f.actor.accountId, txnDate: "2026-10-02", amountPaise: 8000, drCr: "debit", channel: "other", refId: crypto.randomUUID(), rawDescription: "Second bill" });
    const second = await api.call("create_split", { ref: api.txRef(bill2), rev: await api.rev(bill2), participants: [{ person: " kIrAn " }], equal: true, idempotency_key: "p4-second-split" });
    expect(second.applied).toBe(true);
    const bankInput = { inflow_ref: api.txRef(f.ids[1]), person: "Kiran", idempotency_key: "p4-first-bank" };
    const settled = await api.call("record_settlement", bankInput);
    expect(settled.applied).toBe(true);
    expect(settled.allocations).toEqual([
      { share_ref: (created.refs as string[]).find(ref => ref.startsWith("shr_")), person: "Kiran", amount: "50.00", left: "0.00" },
      { share_ref: (second.refs as string[]).find(ref => ref.startsWith("shr_")), person: "Kiran", amount: "10.00", left: "30.00" },
    ]);
    expect(settled.left_open).toBe("30.00"); expect(settled.unallocated).toBe("0.00");
    const replacement = await api.call("create_split", { ...input, replace_existing: true, split_rev: await api.splitRev(f.ids[0]), idempotency_key: "p4-refuse-replace" });
    expect(replacement.applied).toBe(false); expect(JSON.stringify(replacement)).toContain("Kiran");
    const deletion = await api.call("delete_split", { ref, rev: await api.rev(f.ids[0]), split_rev: await api.splitRev(f.ids[0]), idempotency_key: "p4-refuse-delete" });
    expect(deletion.applied).toBe(false);
    const inflow2 = crypto.randomUUID();
    await f.db.insert(f.schema.transactions).values({ id: inflow2, accountId: f.actor.accountId, txnDate: "2026-10-03", amountPaise: 1500, drCr: "credit", channel: "other", refId: crypto.randomUUID(), rawDescription: "More repayment" });
    const more = await api.call("record_settlement", { inflow_ref: api.txRef(inflow2), person: "Kiran", idempotency_key: "p4-second-bank" });
    expect(more.applied).toBe(true); expect(more.left_open).toBe("15.00");
    process.env.AUTH_SECRET = "rotated-after-write";
    expect(await api.call("record_settlement", bankInput)).toEqual({ ...settled, replayed: true });
    process.env.AUTH_SECRET = "phase4-adapter-secret";
    await expect(api.call("record_settlement", { ...bankInput, person: "Different" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await api.undo(more.change_id, "p4-undo-more")).applied).toBe(true);
    expect((await api.undo(settled.change_id, "p4-undo-bank")).applied).toBe(true);
    expect((await api.undo(second.change_id, "p4-undo-second-split")).applied).toBe(true);
    expect((await api.undo(created.change_id, "p4-undo-first-split")).applied).toBe(true);
    expect(await f.db.select().from(f.schema.splits).where(inArray(f.schema.splits.transactionId, [bill2, f.ids[0]]))).toHaveLength(0);
    const history = await f.listChanges(f.actor);
    expect(history.some(row => row.source === "mcp" && row.summary === "Lunch split")).toBe(true);
    for (const response of [created, second, settled, more]) {
      expect(JSON.stringify(response)).not.toContain(f.actor.userId); expect(JSON.stringify(response)).not.toContain(f.ids[0]);
    }
  }), 120000);

  test("phase4 MCP rename and standing note have guarded exact undo and undo of undo", () => phase4Fixture(async (f, api) => {
    const input = { ref: api.txRef(f.ids[0]), display_name: "Rooster X", current_display_name: "Lunch", idempotency_key: "p4-rename-payee" };
    const renamed = await api.call("rename_payee", input);
    expect(renamed.applied).toBe(true);
    expect((await f.db.select().from(f.schema.counterparties).where(eq(f.schema.counterparties.id, f.payee)))[0].displayName).toBe("Rooster X");
    const refused = await api.call("rename_payee", { ...input, display_name: "Wrong", idempotency_key: "p4-stale-rename" });
    expect(refused.applied).toBe(false); expect(JSON.stringify(refused)).toContain("stale");
    expect(await api.call("rename_payee", input)).toEqual({ ...renamed, replayed: true });
    const undone = await api.undo(renamed.change_id, "p4-undo-rename"); expect(undone.applied).toBe(true);
    expect((await f.db.select().from(f.schema.counterparties).where(eq(f.schema.counterparties.id, f.payee)))[0].displayName).toBe("Lunch");
    expect((await api.undo(undone.change_id, "p4-redo-rename")).applied).toBe(true);
    const noteInput = { body: "  Kiran ravi@bank 123456 always food  ", idempotency_key: "p4-standing-note" };
    const note = await api.call("add_standing_note", noteInput);
    expect(note.applied).toBe(true); expect((note.refs as string[])[0]).toStartWith("nte_");
    const rows = () => f.db.select().from(f.schema.assistantContextNotes).where(eq(f.schema.assistantContextNotes.userId, f.actor.userId));
    const original = await rows(); expect(original[0].body).toBe(noteInput.body.trim());
    expect(await api.call("add_standing_note", noteInput)).toEqual({ ...note, replayed: true });
    const removed = await api.undo(note.change_id, "p4-undo-note"); expect(removed.applied).toBe(true); expect(await rows()).toHaveLength(0);
    const restored = await api.undo(removed.change_id, "p4-redo-note"); expect(restored.applied).toBe(true); expect(await rows()).toEqual(original);
    await f.db.update(f.schema.assistantContextNotes).set({ body: "edited later" }).where(eq(f.schema.assistantContextNotes.id, original[0].id));
    expect((await api.undo(restored.change_id, "p4-stale-note-undo")).applied).toBe(false);
    const stranger = await api.call("rename_payee", { ...input, ref: api.txRef(f.otherId), idempotency_key: "p4-foreign-payee" }); expect(stranger.applied).toBe(false); expect(JSON.stringify(stranger)).toContain("not_found");
  }), 90000);

  test("phase4 shared cores cap combined net legs and prevent owed edits below settlements", () => fixture(async f => {
    const r = await relationalFixture(f);
    const expense = await r.owed.createOwedExpense(f.app, r.expenseInput);
    const before = await r.snapshot();
    await expect(r.net.saveNetEvent(f.app, { eventDate: "2026-10-04", inflowTransactionId: f.ids[1], legs: [
      { kind: "receivable", splitParticipantId: r.share.id, amountPaise: 4000, method: "bank" },
      { kind: "receivable", splitParticipantId: r.share.id, amountPaise: 3000, method: "offset" },
      { kind: "payable", owedExpenseId: expense.value, amountPaise: 3000, method: "offset" },
    ] })).rejects.toThrow("Combined receivable legs");
    expect(await r.snapshot()).toEqual(before);
    await expect(r.net.saveNetEvent(f.app, { eventDate: "2026-10-04", legs: [
      { kind: "receivable", splitParticipantId: r.share.id, amountPaise: 6000, method: "offset" },
      { kind: "payable", owedExpenseId: expense.value, amountPaise: 3000, method: "offset" },
      { kind: "payable", owedExpenseId: expense.value, amountPaise: 3000, method: "offset" },
    ] })).rejects.toThrow("Combined payable legs");
    expect(await r.snapshot()).toEqual(before);
    await f.db.insert(f.schema.settlements).values({ owedExpenseId: expense.value, amountPaise: 3000, method: "cash" });
    const settled = await r.snapshot();
    await expect(r.owed.updateOwedExpense(f.app, { id: expense.value, amountPaise: 2999 })).rejects.toThrow("existing settlements of ₹30.00");
    expect(await r.snapshot()).toEqual(settled);
    expect((await r.owed.updateOwedExpense(f.app, { id: expense.value, amountPaise: 3000 })).changeId).toBeTruthy();
  }), 60000);

  test("phase4 MCP wrappers cover explicit and incremental allocations, cash/writeoffs, net and owed writes", () => phase4Fixture(async (f, api) => {
    const r = await relationalFixture(f);
    const sh = api.shareRef(r.share.id), inflow = api.txRef(f.ids[1]);
    for (const [tool, args] of [
      ["record_cash_settlement", { share_ref: api.shareRef("foreign-share"), amount: "1" }],
      ["delete_owed_expense", { owed_ref: api.owedRef("foreign-expense") }],
      ["undo_write_off", { settlement_ref: "stl_unknown" }],
    ] as const) {
      const refused = await api.call(tool, { ...args, idempotency_key: `p4-unknown-${tool}` });
      expect(refused.applied).toBe(false); expect(JSON.stringify(refused)).toContain("not_found");
    }
    const refuse = await api.call("record_settlement", { inflow_ref: inflow, person: "Kir", idempotency_key: "p4-close-name" });
    expect(refuse.applied).toBe(false); expect(JSON.stringify(refuse)).toContain("Kiran");
    const first = await api.call("record_settlement", { inflow_ref: inflow, person: "Kiran", allocations: [{ share_ref: sh, amount: "10" }], idempotency_key: "p4-explicit-bank" }); expect(first.applied).toBe(true);
    const second = await api.call("record_settlement", { inflow_ref: inflow, person: "Kiran", allocations: [{ share_ref: sh, amount: 10 }], idempotency_key: "p4-increment-bank" }); expect(second.applied).toBe(true); expect(second.unallocated).toBe("20.00");
    const bankRows = await f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.inflowTransactionId, f.ids[1]));
    expect(bankRows.reduce((n, row) => n + row.amountPaise, 0)).toBe(2000);
    expect((await api.call("record_settlement", { inflow_ref: inflow, person: "Kiran", allocations: [{ share_ref: sh, amount: "20.01" }], idempotency_key: "p4-over-bank" })).applied).toBe(false);
    expect((await api.call("clear_settlement", { inflow_ref: inflow, idempotency_key: "p4-clear-bank" })).applied).toBe(true);
    const cash = await api.call("record_cash_settlement", { share_ref: sh, amount: "5", idempotency_key: "p4-cash-1" }); expect(cash).toMatchObject({ applied: true });
    expect((await api.call("record_cash_settlement", { share_ref: sh, amount: "55.01", idempotency_key: "p4-over-cash" })).applied).toBe(false);
    const writeoff = await api.call("write_off_share", { share_ref: sh, idempotency_key: "p4-writeoff" }); expect(writeoff.applied).toBe(true);
    const stl = (writeoff.refs as string[]).find(ref => ref.startsWith("stl_"))!;
    expect((await api.call("undo_write_off", { settlement_ref: stl, idempotency_key: "p4-remove-writeoff" })).applied).toBe(true);
    const add = await api.call("add_owed_expense", { person: "Kiran", date: "2026-10-02", what: "Dinner", amount: "15", idempotency_key: "p4-add-owed" }); expect(add.applied).toBe(true);
    const owedRef = (add.refs as string[]).find(ref => ref.startsWith("owe_"))!;
    const update = await api.call("update_owed_expense", { owed_ref: owedRef, amount: "10", what: "Dinner corrected", idempotency_key: "p4-edit-owed" }); expect(update.applied).toBe(true);
    const net = await api.call("net_settle", { date: "2026-10-04", inflow_ref: inflow, receivables: [{ share_ref: sh, amount: "50", expected_outstanding: "55" }], payables: [{ owed_ref: owedRef, amount: "10", expected_outstanding: "10" }], idempotency_key: "p4-net-settle" }); expect(net.applied).toBe(true);
    expect((await api.call("record_settlement", { inflow_ref: inflow, person: "Kiran", idempotency_key: "p4-net-bank-refusal" })).applied).toBe(false);
    expect((await api.undo(net.change_id, "p4-undo-net")).applied).toBe(true);
    const deleted = await api.call("delete_owed_expense", { owed_ref: owedRef, idempotency_key: "p4-delete-owed" }); expect(deleted.applied).toBe(true);
    expect((await api.undo(deleted.change_id, "p4-undo-delete-owed")).applied).toBe(true);
    const sourced = await api.call("add_owed_expense", { person: "Kiran", date: "2026-10-04", what: "Money to return", amount: "40", source_inflow_ref: inflow, idempotency_key: "p4-source-owed" }); expect(sourced.applied).toBe(true);
    expect((await api.call("add_owed_expense", { person: "Kiran", date: "2026-10-04", what: "Duplicate", amount: "1", source_inflow_ref: inflow, idempotency_key: "p4-source-duplicate" })).applied).toBe(false);
    const stale = await api.call("create_split", { ref: api.txRef(f.ids[0]), rev: "stale", equal: true, participants: [{ person: "Kiran" }], idempotency_key: "p4-stale-split" });
    expect(stale.applied).toBe(false); expect(JSON.stringify(stale)).toContain("current_rev");
  }), 180000);

  test("phase4 cores recheck snapshot and transaction revisions under relational locks", () => fixture(async f => {
    const r = await relationalFixture(f);
    const { relationalSnapshot } = await import("./relational-store");
    const old = await relationalSnapshot(f.db, f.app);
    const before = (await f.listChanges(f.actor)).length;
    await f.db.update(f.schema.splitParticipants).set({ expectedAmountPaise: 5999 }).where(eq(f.schema.splitParticipants.id, r.share.id));
    await expect(r.settlements.recordCashSettlement({ ...f.mcp("p4-stale-snapshot"), expectedRelations: old }, { splitParticipantId: r.share.id, amountPaise: 100, note: null })).rejects.toMatchObject({ code: "stale" });
    expect((await f.listChanges(f.actor)).length).toBe(before);
    const previous = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "p4-locked-rev";
    try {
      const key = deriveMcpRevKey(process.env.AUTH_SECRET);
      const rev = transactionRev(key, f.actor.userId, f.ids[0], await f.read());
      await f.db.update(f.schema.transactions).set({ note: "changed after read" }).where(eq(f.schema.transactions.id, f.ids[0]));
      await expect(r.splits.deleteSplit({ ...f.mcp("p4-stale-core-rev"), transactionRevs: { [f.ids[0]]: rev } }, { transactionId: f.ids[0], expectNoSettlements: true })).rejects.toMatchObject({ code: "stale", current_rev: transactionRev(key, f.actor.userId, f.ids[0], await f.read()) });
      expect((await f.listChanges(f.actor)).length).toBe(before);
    } finally {
      if (previous === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = previous;
    }
  }), 60000);

  test("phase 5 link_person set, replay, guards, undo and undo-of-undo preserve people and find new inflows", () => fixture(async f => {
    const { linkPayeesToPerson } = await import("./person-links");
    const { mcpReadOps } = await import("@/lib/mcp/read-ops");
    const { buildReadView, getOpenBalances } = await import("@/lib/mcp/model-view");
    const { deriveMcpRefKey } = await import("@/lib/mcp/refs");
    const links = [{ counterpartyId: f.payee, person: "Kiran", currentPerson: null, createPerson: true }];
    await f.db.update(f.schema.transactions).set({ drCr: "credit" }).where(eq(f.schema.transactions.id, f.ids[0]));
    const result = await linkPayeesToPerson(f.mcp("p5-link-person", links), links);
    expect(result.changeId).toBeTruthy();
    const [payee] = await f.db.select().from(f.schema.counterparties).where(eq(f.schema.counterparties.id, f.payee));
    const [person] = await f.db.select().from(f.schema.persons).where(eq(f.schema.persons.id, payee.personId!));
    expect(person).toMatchObject({ userId: f.actor.userId, name: "Kiran" });
    expect((await f.listChanges(f.actor))[0].summary).toContain("Linked");
    const replay = await linkPayeesToPerson(f.mcp("p5-link-person", links), links);
    expect(replay.replayed).toBe(true); expect(replay.changeId).toBe(result.changeId);
    await expect(linkPayeesToPerson(f.mcp("p5-link-person", { different: true }), links)).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(linkPayeesToPerson(f.mcp("p5-bad-guard"), links)).rejects.toMatchObject({ code: "stale" });
    const model = await mcpReadOps.readModel(f.actor);
    const view = buildReadView(model, f.actor, deriveMcpRefKey("p5-test"), deriveMcpRevKey("p5-test"));
    expect(getOpenBalances(view, "Kiran").people[0].unlinked_inflows).toMatchObject([{ amount: "100.00", via: "linked" }]);
    const undo = await f.undoChange(f.app, result.changeId!);
    expect(undo.stale).toBeUndefined();
    expect((await f.db.select().from(f.schema.counterparties).where(eq(f.schema.counterparties.id, f.payee)))[0].personId).toBeNull();
    expect(await f.db.select().from(f.schema.persons).where(eq(f.schema.persons.id, person.id))).toHaveLength(0);
    const redo = await f.undoChange(f.app, undo.changeId!);
    expect(redo.stale).toBeUndefined();
    expect((await f.db.select().from(f.schema.counterparties).where(eq(f.schema.counterparties.id, f.payee)))[0].personId).toBe(person.id);
    await linkPayeesToPerson(f.app, [{ counterpartyId: f.payee, person: null, currentPerson: " kIrAn " }]);
    expect((await f.undoChange(f.app, redo.changeId!)).stale).toBeTruthy();
  }), 120000);

  test("phase 5 link_person refuses foreign people/payees and rolls back a whole stale batch", () => fixture(async f => {
    const { linkPayeesToPerson } = await import("./person-links");
    const foreignPerson = crypto.randomUUID(), second = crypto.randomUUID(), foreignPayee = crypto.randomUUID();
    await f.db.insert(f.schema.persons).values({ id: foreignPerson, userId: f.otherUser, name: "Foreign Only" });
    await f.db.insert(f.schema.counterparties).values([
      { id: second, userId: f.actor.userId, key: "kiranrao-1", kind: "merchant" },
      { id: foreignPayee, userId: f.otherUser, key: "foreign", kind: "merchant" },
    ]);
    await expect(linkPayeesToPerson(f.app, [{ counterpartyId: f.payee, person: "Foreign Only", currentPerson: null }])).rejects.toThrow("Unknown person");
    await expect(linkPayeesToPerson(f.app, [{ counterpartyId: foreignPayee, person: "Kiran", currentPerson: null, createPerson: true }])).rejects.toMatchObject({ code: "not_found" });
    await expect(linkPayeesToPerson(f.app, [
      { counterpartyId: f.payee, person: "Kiran", currentPerson: null, createPerson: true },
      { counterpartyId: second, person: "Kiran", currentPerson: "Wrong", createPerson: true },
    ])).rejects.toMatchObject({ code: "stale" });
    expect((await f.db.select().from(f.schema.counterparties).where(eq(f.schema.counterparties.id, f.payee)))[0].personId).toBeNull();
    expect(await f.db.select().from(f.schema.persons).where(eq(f.schema.persons.userId, f.actor.userId))).toHaveLength(0);
    const linked = await linkPayeesToPerson(f.app, [{ counterpartyId: f.payee, person: "Kiran", currentPerson: null, createPerson: true }]);
    await linkPayeesToPerson(f.app, [{ counterpartyId: second, person: "Kiran", currentPerson: null }]);
    // Removing a newly-created person would cascade to another confirmed link.
    expect((await f.undoChange(f.app, linked.changeId!)).stale).toBeTruthy();
  }), 120000);

  test("phase 5 link_person adapter resolves payee keys and refs and replays the complete response", () => fixture(async f => {
    const { mcpRelationalWrite } = await import("@/lib/mcp/relational-write-ops");
    const { deriveMcpRefKey, transactionRef } = await import("@/lib/mcp/refs");
    const previous = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "phase-5-synthetic-secret";
    try {
      const [payee] = await f.db.select().from(f.schema.counterparties).where(eq(f.schema.counterparties.id, f.payee));
      const p = { actor: f.actor, scope: "write" as const, tokenId: f.tokenId, label: "Phase 5 test" };
      const input = { links: [{ payee: payee.key, person: "Kiran", current_person: null, create_person: true }], idempotency_key: "p5-adapter-link" };
      const linked = await mcpRelationalWrite(p, "link_person", input);
      expect(linked).toMatchObject({ applied: true, summary: `Linked ${payee.key} to Kiran` });
      expect(typeof linked.change_id).toBe("string");
      expect(linked.refs).toHaveLength(2);
      expect(JSON.stringify(linked)).not.toContain(f.payee);
      expect(await mcpRelationalWrite(p, "link_person", input)).toEqual({ ...linked, replayed: true });
      const ref = transactionRef(deriveMcpRefKey(process.env.AUTH_SECRET), f.actor.userId, f.ids[0]);
      const unlinked = await mcpRelationalWrite(p, "link_person", { links: [{ ref, person: null, current_person: " kIrAn " }], idempotency_key: "p5-adapter-unlink" });
      expect(unlinked).toMatchObject({ applied: true });
      expect((await f.db.select().from(f.schema.counterparties).where(eq(f.schema.counterparties.id, f.payee)))[0].personId).toBeNull();
      expect(await mcpRelationalWrite({ ...p, scope: "read" }, "link_person", input)).toMatchObject({ applied: false, errors: [{ code: "forbidden" }] });
    } finally {
      if (previous === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = previous;
    }
  }), 120000);

});
