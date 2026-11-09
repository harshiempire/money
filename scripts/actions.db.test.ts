/**
 * Real action specs against the local Docker test database only: every test is
 * skipped unless DATABASE_URL equals ~/.money-scratch/ledger-test/dburl (see
 * scripts/lib/local-dev-guard.ts), so the .env production URL is refused.
 *
 * Run this file on its own (bun run test:actions-db): the registration test
 * uses mock.module for Next/Auth.js boundaries, and Bun's module mocks are
 * process-wide.
 */
import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { eq, inArray } from "drizzle-orm";
import { isTestDatabase } from "./lib/local-dev-guard";
import { runAction, type ActionSpec } from "@/lib/action/core";
import { CurrentUser, Db } from "@/lib/action/services";
import { unwrap } from "@/lib/action/result";

const dbTest = test.skipIf(!isTestDatabase());

async function fixture(
  run: (f: Awaited<ReturnType<typeof seed>>) => Promise<void>,
) {
  // This function is called only inside a guarded test, before any DB import.
  const target = new URL(process.env.DATABASE_URL!);
  if (
    target.hostname !== "127.0.0.1" ||
    target.port !== "54330" ||
    target.pathname !== "/money_test"
  ) {
    throw new Error(
      "Action tests require the authorized local money_test database.",
    );
  }
  const f = await seed();
  try {
    await run(f);
  } finally {
    await f.cleanup();
  }
}

async function seed() {
  const { db, schema } = await import("@/db");
  const split = await import("@/app/transactions/split-handlers");
  const net = await import("@/app/transactions/net-event-handlers");
  const cash = await import("@/app/reimbursements/settlement-handlers");
  const owed = await import("@/app/reimbursements/owed-expense-handlers");
  const txns = await import("@/app/transactions/transaction-handlers");
  const spend = await import("@/app/spend/spend-handlers");
  const id = () => crypto.randomUUID();
  const user = id(),
    other = id(),
    account = id(),
    otherAccount = id();
  const debit = id(),
    credit = id(),
    sibling = id(),
    foreign = id(),
    category = id(),
    foreignCategory = id(),
    payee = id();
  const users = [user, other];
  const cleanup = async () => {
    await db
      .delete(schema.transactions)
      .where(inArray(schema.transactions.accountId, [account, otherAccount]));
    await db
      .delete(schema.counterparties)
      .where(inArray(schema.counterparties.userId, users));
    await db.delete(schema.users).where(inArray(schema.users.id, users));
  };
  try {
    await db
      .insert(schema.users)
      .values(users.map((id) => ({ id, email: `${id}@actions.test` })));
    await db.insert(schema.moneyAccounts).values(
      [
        { id: account, userId: user },
        { id: otherAccount, userId: other },
      ].map((r) => ({
        ...r,
        bank: "bob",
        name: "Test",
        openingDate: "2026-10-01",
        openingBalancePaise: 0,
      })),
    );
    await db.insert(schema.categories).values([
      { id: category, userId: user, name: "Food", kind: "spend" },
      { id: foreignCategory, userId: other, name: "Travel", kind: "spend" },
    ]);
    await db
      .insert(schema.counterparties)
      .values({
        id: payee,
        userId: user,
        key: id(),
        kind: "merchant",
        displayName: "Kiran",
      });
    await db.insert(schema.transactions).values(
      [debit, credit, sibling, foreign].map((id) => ({
        id,
        accountId: id === foreign ? otherAccount : account,
        txnDate: "2026-10-01",
        amountPaise: id === credit ? 4000 : 10000,
        drCr: id === credit ? ("credit" as const) : ("debit" as const),
        channel: "other" as const,
        refId: id,
        rawDescription: "Lunch",
        counterpartyId: id === foreign ? null : payee,
      })),
    );
  } catch (e) {
    await cleanup();
    throw e;
  }
  const layer = Layer.merge(
    Layer.succeed(CurrentUser, { id: user, email: null }),
    Layer.succeed(Db, db),
  );
  const otherLayer = Layer.merge(
    Layer.succeed(CurrentUser, { id: other, email: null }),
    Layer.succeed(Db, db),
  );
  const paths: string[] = [];
  const call = <I, E, A, D = A>(
    spec: ActionSpec<I, E, A, CurrentUser | Db, D>,
    raw: unknown,
    asOther = false,
  ) =>
    runAction(spec, raw, {
      name: "actions-db-test",
      layer: asOther ? otherLayer : layer,
      // Mirrors define-action.ts's revalidateFor.
      onSuccess: (r) => {
        if (spec.revalidateWhen && !spec.revalidateWhen(r)) return;
        const picked = typeof spec.revalidate === "function" ? spec.revalidate(r) : spec.revalidate;
        paths.push(...(picked ?? []));
      },
    });
  const read = async (id = debit) =>
    (
      await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, id))
    )[0];
  const splitInput = {
    transactionId: debit,
    totalPaise: 10000,
    yourSharePaise: 4000,
    note: null,
    participants: [{ personName: "Kiran", expectedAmountPaise: 6000 }],
  };
  const makeShare = async () => {
    expect(await call(split.createSplitSpec, splitInput)).toEqual({
      ok: true,
      data: undefined,
    });
    const [s] = await db
      .select()
      .from(schema.splits)
      .where(eq(schema.splits.transactionId, debit));
    return (
      await db
        .select()
        .from(schema.splitParticipants)
        .where(eq(schema.splitParticipants.splitId, s.id))
    )[0];
  };
  return {
    db,
    schema,
    user,
    other,
    account,
    otherAccount,
    debit,
    credit,
    sibling,
    foreign,
    category,
    foreignCategory,
    payee,
    layer,
    call,
    paths,
    read,
    split,
    net,
    cash,
    owed,
    txns,
    spend,
    splitInput,
    makeShare,
    cleanup,
  };
}

function failure(result: unknown, code: string, message?: string) {
  expect(result).toMatchObject({
    ok: false,
    code,
    ...(message ? { message } : {}),
  });
}

dbTest(
  "split actions: create, allocate, clear, delete; exact ledger failures, ownership and schemas",
  () =>
    fixture(async (f) => {
      failure(
        await f.call(f.split.createSplitSpec, {
          ...f.splitInput,
          participants: [{ personName: "   ", expectedAmountPaise: 6000 }],
        }),
        "INVALID",
        "Person name must not be empty",
      );
      const share = await f.makeShare();
      expect(share.expectedAmountPaise).toBe(6000);
      expect(f.paths).toEqual(["/transactions", "/review", "/", "/timeline", "/connections", "/reimbursements", "/people", "/spend"]);
      failure(
        await f.call(f.split.createSplitSpec, {
          ...f.splitInput,
          transactionId: f.foreign,
        }),
        "FORBIDDEN",
      );
      failure(
        await f.call(f.split.createSplitSpec, {
          ...f.splitInput,
          totalPaise: "10000",
        }),
        "INVALID",
      );
      failure(
        await f.call(f.split.createSplitSpec, {
          ...f.splitInput,
          participants: [
            { personName: "Kiran", expectedAmountPaise: 3000 },
            { personName: "kiran", expectedAmountPaise: 3000 },
          ],
        }),
        "INVALID",
        "Kiran appears twice in this split. Each person may only have one share.",
      );
      expect(
        await f.call(f.split.recordSettlementSpec, {
          inflowTransactionId: f.credit,
          allocations: [{ splitParticipantId: share.id, amountPaise: 1000 }],
        }),
      ).toMatchObject({ ok: true, data: { appliedPaise: 1000, unallocatedPaise: 3000 } });
      const [settled] = await f.db
        .select()
        .from(f.schema.settlements)
        .where(eq(f.schema.settlements.splitParticipantId, share.id));
      expect(settled.amountPaise).toBe(1000);
      expect(
        await f.call(f.split.clearSettlementSpec, {
          inflowTransactionId: f.credit,
        }),
      ).toEqual({ ok: true, data: undefined });
      expect(
        await f.db
          .select()
          .from(f.schema.settlements)
          .where(eq(f.schema.settlements.splitParticipantId, share.id)),
      ).toHaveLength(0);
      expect(
        await f.call(f.split.deleteSplitSpec, { transactionId: f.debit }),
      ).toEqual({ ok: true, data: undefined });
      expect(
        await f.db
          .select()
          .from(f.schema.splits)
          .where(eq(f.schema.splits.transactionId, f.debit)),
      ).toHaveLength(0);
    }),
  30000,
);

dbTest(
  "cash/writeoff actions: exact amounts, no-op revalidation, undo and core error",
  () =>
    fixture(async (f) => {
      const share = await f.makeShare();
      f.paths.length = 0;
      expect(
        await f.call(f.cash.recordCashSettlementSpec, {
          splitParticipantId: share.id,
          amountPaise: NaN,
          note: null,
        }),
      ).toMatchObject({ ok: false, code: "INVALID", message: "Enter an amount above ₹0.00." });
      expect(f.paths).toEqual([]);
      failure(
        await f.call(
          f.cash.recordCashSettlementSpec,
          { splitParticipantId: share.id, amountPaise: 10, note: null },
          true,
        ),
        "FORBIDDEN",
      );
      failure(
        await f.call(f.cash.recordCashSettlementSpec, {
          splitParticipantId: share.id,
          amountPaise: "10",
          note: null,
        }),
        "INVALID",
      );
      expect(
        await f.call(f.cash.recordCashSettlementSpec, {
          splitParticipantId: share.id,
          amountPaise: 2000,
          note: " lunch ",
        }),
      ).toEqual({ ok: true, data: { appliedPaise: 2000, leftPaise: 4000 } });
      const [cash] = await f.db
        .select()
        .from(f.schema.settlements)
        .where(eq(f.schema.settlements.splitParticipantId, share.id));
      expect(cash).toMatchObject({
        method: "cash",
        amountPaise: 2000,
        note: "lunch",
      });
      expect(
        await f.call(f.cash.deleteCashSettlementSpec, {
          settlementId: cash.id,
        }),
      ).toEqual({ ok: true, data: undefined });
      expect(
        await f.call(f.cash.writeOffParticipantShareSpec, {
          splitParticipantId: share.id,
          note: null,
        }),
      ).toEqual({ ok: true, data: undefined });
      failure(
        await f.call(f.cash.writeOffParticipantShareSpec, {
          splitParticipantId: share.id,
          note: null,
        }),
        "INVALID",
        "Nothing outstanding on this share to forgive.",
      );
      const [writeoff] = await f.db
        .select()
        .from(f.schema.settlements)
        .where(eq(f.schema.settlements.splitParticipantId, share.id));
      expect(writeoff).toMatchObject({ method: "writeoff", amountPaise: 6000 });
      expect(
        await f.call(f.cash.undoWriteOffSpec, { settlementId: writeoff.id }),
      ).toEqual({ ok: true, data: undefined });
      expect(
        await f.db
          .select()
          .from(f.schema.settlements)
          .where(eq(f.schema.settlements.splitParticipantId, share.id)),
      ).toHaveLength(0);
    }),
  30000,
);

dbTest(
  "owed expense actions: returned id, create/update/delete rows and guarded failures",
  () =>
    fixture(async (f) => {
      const input = {
        personName: "Arjun",
        incurredDate: "2026-10-03",
        amountPaise: 5000,
        description: "Dinner",
        categoryId: f.category,
        note: null,
      };
      failure(
        await f.call(f.owed.createOwedExpenseSpec, {
          ...input,
          amountPaise: 0,
        }),
        "INVALID",
        "Amount must be positive",
      );
      failure(
        await f.call(f.owed.createOwedExpenseSpec, {
          ...input,
          categoryId: f.foreignCategory,
        }),
        "FORBIDDEN",
      );
      failure(
        await f.call(f.owed.createOwedExpenseSpec, { ...input, personName: "  " }),
        "INVALID",
        "Person name must not be empty",
      );
      failure(
        await f.call(f.owed.createOwedExpenseSpec, {
          ...input,
          amountPaise: "5000",
        }),
        "INVALID",
      );
      const created = unwrap(await f.call(f.owed.createOwedExpenseSpec, input));
      const [row] = await f.db
        .select()
        .from(f.schema.owedExpenses)
        .where(eq(f.schema.owedExpenses.id, created));
      expect(row).toMatchObject({
        userId: f.user,
        amountPaise: 5000,
        description: "Dinner",
      });
      failure(
        await f.call(
          f.owed.updateOwedExpenseSpec,
          { id: created, amountPaise: 6000 },
          true,
        ),
        "FORBIDDEN",
      );
      failure(
        await f.call(f.owed.updateOwedExpenseSpec, { id: created, personName: " " }),
        "INVALID",
        "Person name must not be empty",
      );
      expect(
        await f.call(f.owed.updateOwedExpenseSpec, {
          id: created,
          amountPaise: 6000,
          note: " meal ",
        }),
      ).toEqual({ ok: true, data: undefined });
      expect(
        (
          await f.db
            .select()
            .from(f.schema.owedExpenses)
            .where(eq(f.schema.owedExpenses.id, created))
        )[0],
      ).toMatchObject({ amountPaise: 6000, note: "meal" });
      expect(
        await f.call(f.owed.deleteOwedExpenseSpec, { id: created }),
      ).toEqual({ ok: true, data: undefined });
      expect(
        await f.db
          .select()
          .from(f.schema.owedExpenses)
          .where(eq(f.schema.owedExpenses.id, created)),
      ).toHaveLength(0);
    }),
  30000,
);

dbTest(
  "guided net action preserves cash methods and stale balance guards through decoding",
  () => fixture(async (f) => {
    const share = await f.makeShare();
    const owedExpenseId = unwrap(await f.call(f.owed.createOwedExpenseSpec, {
      personName: "Kiran", incurredDate: "2026-10-03", amountPaise: 18500,
      description: "Dinner", categoryId: f.category,
    }));
    const legs = [
      {kind: "receivable", splitParticipantId: share.id, amountPaise: 6000, method: "offset", expectedOutstandingPaise: 6000},
      {kind: "payable", owedExpenseId, amountPaise: 12500, method: "cash", expectedOutstandingPaise: 18500},
      {kind: "payable", owedExpenseId, amountPaise: 6000, method: "offset", expectedOutstandingPaise: 18500},
    ];
    f.paths.length = 0;
    failure(await f.call(f.net.saveNetEventSpec, {legs: legs.map(leg => ({...leg, expectedOutstandingPaise: 1}))}), "CONFLICT");
    expect(f.paths).toEqual([]);
    failure(await f.call(f.net.saveNetEventSpec, {legs}, true), "FORBIDDEN");
    const saved = unwrap(await f.call(f.net.saveNetEventSpec, {legs}));
    const rows = await f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.netEventId, saved.netEventId));
    expect(rows.filter(row => row.method === "cash").map(row => Number(row.amountPaise))).toEqual([12500]);
    expect(rows.filter(row => row.method === "offset").map(row => Number(row.amountPaise))).toEqual([6000,6000]);
    expect(f.paths).toContain("/connections");
    expect(await f.call(f.net.deleteNetEventSpec, {netEventId: saved.netEventId})).toEqual({ok: true, data: undefined});
  }),
  30000,
);

dbTest("net app and MCP return the same cash receipt, and MCP requires the outstanding guard", () => fixture(async f => {
  const share = await f.makeShare();
  const app = unwrap(await f.call(f.net.saveNetEventSpec, { legs: [{ kind: "receivable", splitParticipantId: share.id, amountPaise: 2001, method: "cash", expectedOutstandingPaise: 6000 }] }));
  await f.call(f.net.deleteNetEventSpec, { netEventId: app.netEventId });
  const { mcpRelationalWrite } = await import("@/lib/mcp/relational-write-ops");
  const refs = await import("@/lib/mcp/refs");
  const previous = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "net-parity-test-secret";
  try {
    const actor = { userId: f.user, accountId: f.account };
    const principal = { actor, scope: "write" as const, tokenId: crypto.randomUUID(), label: "Test" };
    const ref = refs.shareRef(refs.deriveMcpRefKey(process.env.AUTH_SECRET), f.user, f.account, share.id);
    const row = { share_ref: ref, amount: "20.01", method: "cash" };
    const missing = await mcpRelationalWrite(principal, "net_settle", { receivables: [row], payables: [], idempotency_key: "missing-guard" });
    expect(missing).toMatchObject({ applied: false, errors: [{ code: "invalid_input" }] });
    const token = crypto.randomUUID();
    await f.db.insert(f.schema.mcpTokens).values({ id: token, userId: f.user, accountId: f.account, name: "Test", tokenHash: crypto.randomUUID(), tokenHint: "testhint", scope: "write", userTokenVersion: 0 });
    principal.tokenId = token;
    const saved = await mcpRelationalWrite(principal, "net_settle", { receivables: [{ ...row, expected_outstanding: "60" }], payables: [], idempotency_key: "matching-guard" });
    expect(saved.applied).toBe(true);
    expect(saved.receipt).toEqual({ date: app.receipt.eventDate, bank_inflow: "0.00", bank_outflow: "0.00", legs: app.receipt.legs.map(l => ({ kind: l.kind, ref, method: l.method, amount: (l.amountPaise / 100).toFixed(2), left: (l.leftPaise / 100).toFixed(2) })) });
  } finally { process.env.AUTH_SECRET = previous; }
}), 30000);

dbTest(
  "net actions: return event id, rows, delete, exact ledger failure and ownership",
  () =>
    fixture(async (f) => {
      const share = await f.makeShare();
      const input = {
        eventDate: "2026-10-04",
        inflowTransactionId: f.credit,
        legs: [
          {
            kind: "receivable",
            splitParticipantId: share.id,
            amountPaise: 4000,
            method: "bank",
          },
        ],
      };
      failure(
        await f.call(f.net.saveNetEventSpec, {
          eventDate: "2026-10-04",
          legs: [],
        }),
        "INVALID",
        "At least one non-zero leg is required",
      );
      failure(await f.call(f.net.saveNetEventSpec, input, true), "FORBIDDEN");
      failure(
        await f.call(f.net.saveNetEventSpec, {
          eventDate: "2026-10-04",
          legs: [
            { kind: "receivable", splitParticipantId: share.id, amountPaise: 1000, method: "offset" },
            {
              kind: "payable",
              amountPaise: 1000,
              method: "offset",
              newPayable: { personName: "  ", incurredDate: "2026-10-04", amountPaise: 1000, description: "Taxi" },
            },
          ],
        }),
        "INVALID",
        "Person name must not be empty",
      );
      failure(
        await f.call(f.net.saveNetEventSpec, { ...input, eventDate: 42 }),
        "INVALID",
      );
      const created = unwrap(await f.call(f.net.saveNetEventSpec, input));
      expect(created.netEventId).toBeString();
      expect(
        (
          await f.db
            .select()
            .from(f.schema.netEvents)
            .where(eq(f.schema.netEvents.id, created.netEventId))
        )[0],
      ).toMatchObject({ userId: f.user, inflowTransactionId: f.credit });
      failure(
        await f.call(
          f.net.deleteNetEventSpec,
          { netEventId: created.netEventId },
          true,
        ),
        "FORBIDDEN",
      );
      expect(
        await f.call(f.net.deleteNetEventSpec, {
          netEventId: created.netEventId,
        }),
      ).toEqual({ ok: true, data: undefined });
      expect(
        await f.db
          .select()
          .from(f.schema.netEvents)
          .where(eq(f.schema.netEvents.id, created.netEventId)),
      ).toHaveLength(0);
    }),
  30000,
);

dbTest(
  "transaction actions: schemas drop isTransfer, exact stale messages, writes and reads",
  () =>
    fixture(async (f) => {
      expect(
        await f.call(f.txns.setTransactionCategorySpec, {
          transactionId: f.debit,
          categoryId: f.category,
          isTransfer: true,
        }),
      ).toEqual({ ok: true, data: undefined });
      expect(await f.read()).toMatchObject({
        categoryId: f.category,
        isTransfer: false,
      });
      failure(
        await f.call(f.txns.setTransactionCategorySpec, {
          transactionId: f.debit,
          categoryId: f.category,
          expectedCurrentCategoryId: null,
        }),
        "CONFLICT",
        "The category changed since this card was made. Ask again to get a fresh card.",
      );
      failure(
        await f.call(f.txns.setTransactionCategorySpec, {
          transactionId: f.foreign,
          categoryId: f.category,
        }),
        "FORBIDDEN",
      );
      // null clears the category, as it did on main; then set it back for the
      // apply-to-payee step below.
      expect(
        await f.call(f.txns.setTransactionCategorySpec, {
          transactionId: f.debit,
          categoryId: null,
        }),
      ).toEqual({ ok: true, data: undefined });
      expect(await f.read()).toMatchObject({ categoryId: null });
      expect(
        await f.call(f.txns.setTransactionCategorySpec, {
          transactionId: f.debit,
          categoryId: f.category,
        }),
      ).toEqual({ ok: true, data: undefined });
      const applied = unwrap(
        await f.call(f.txns.applyCategoryToCounterpartySpec, {
          transactionId: f.debit,
        }),
      );
      expect(applied.updated).toBe(2);
      expect(applied.ids.sort()).toEqual([f.credit, f.sibling].sort());
      expect(
        (
          await f.db
            .select()
            .from(f.schema.counterparties)
            .where(eq(f.schema.counterparties.id, f.payee))
        )[0].defaultCategoryId,
      ).toBe(f.category);
      expect(
        await f.call(f.txns.setTransactionTransferSpec, {
          transactionId: f.debit,
          isTransfer: true,
        }),
      ).toEqual({ ok: true, data: undefined });
      expect(
        await f.call(f.txns.setTransactionNeedsReviewSpec, {
          transactionId: f.debit,
          needsReview: true,
        }),
      ).toEqual({ ok: true, data: undefined });
      expect(
        await f.call(f.txns.setTransactionNoteSpec, {
          transactionId: f.debit,
          note: " Lunch ",
        }),
      ).toEqual({ ok: true, data: undefined });
      expect(await f.read()).toMatchObject({
        isTransfer: true,
        needsReview: true,
        note: "Lunch",
      });
      failure(
        await f.call(f.txns.setTransactionNoteSpec, {
          transactionId: f.debit,
          note: "Dinner",
          expectedCurrentNote: null,
        }),
        "CONFLICT",
        "The note changed since this card was made. Ask again to get a fresh card.",
      );
      expect(
        unwrap(
          await f.call(f.txns.getNoteCandidatesSpec, {
            transactionId: f.debit,
          }),
        )
          .map((r) => r.id)
          .sort(),
      ).toEqual([f.credit, f.sibling].sort());
      failure(
        await f.call(f.txns.getNoteCandidatesSpec, {
          transactionId: f.foreign,
        }),
        "FORBIDDEN",
      );
      expect(
        await f.call(f.txns.applyNoteToTransactionsSpec, {
          transactionIds: [f.sibling],
          note: " Shared ",
        }),
      ).toEqual({ ok: true, data: { updated: 1 } });
      expect((await f.read(f.sibling)).note).toBe("Shared");
      const share = await f.makeShare();
      expect(
        unwrap(
          await f.call(f.txns.getLinkedTransactionPreviewSpec, {
            transactionId: f.debit,
          }),
        ),
      ).toMatchObject({
        id: f.debit,
        split: {
          totalPaise: 10000,
          participants: [
            { personName: share.personName, outstandingAmountPaise: 6000 },
          ],
        },
      });
      failure(
        await f.call(f.txns.getLinkedTransactionPreviewSpec, {
          transactionId: f.foreign,
        }),
        "FORBIDDEN",
      );
      failure(
        await f.call(f.txns.getLinkedTransactionPreviewSpec, {
          transactionId: 42,
        }),
        "INVALID",
      );
    }),
  30000,
);

dbTest(
  "auto detection data and per-result revalidation; empty bulk note skips revalidation",
  () =>
    fixture(async (f) => {
      f.paths.length = 0;
      expect(
        await f.call(f.txns.applyNoteToTransactionsSpec, {
          transactionIds: [],
          note: "x",
        }),
      ).toEqual({ ok: true, data: { updated: 0 } });
      expect(f.paths).toEqual([]);
      expect(await f.call(f.txns.autoDetectTransfersSpec, undefined)).toEqual({
        ok: true,
        data: { pairs: 0 },
      });
      // The shared field-edit capability refreshes both doors' path union.
      expect(f.paths).toEqual(["/transactions", "/review", "/", "/timeline", "/connections"]);
      await f.db
        .update(f.schema.transactions)
        .set({ amountPaise: 10000 })
        .where(eq(f.schema.transactions.id, f.credit));
      const detected = unwrap(
        await f.call(f.txns.autoDetectTransfersSpec, undefined),
      );
      expect(detected.pairs).toBeGreaterThan(0);
      expect((await f.read(f.credit)).isTransfer).toBe(true);
    }),
  30000,
);

dbTest(
  "spend read: tenant-scoped rows, foreign category returns empty and malformed input is INVALID",
  () =>
    fixture(async (f) => {
      const rows = unwrap(
        await f.call(f.spend.getCategoryTransactionsSpec, {
          categoryId: null,
          from: null,
          to: null,
        }),
      );
      expect(rows.some((r) => r.id === f.debit)).toBe(true);
      expect(rows.some((r) => r.id === f.foreign)).toBe(false);
      expect(
        await f.call(f.spend.getCategoryTransactionsSpec, {
          categoryId: f.foreignCategory,
          from: null,
          to: null,
        }),
      ).toEqual({ ok: true, data: [] });
      failure(
        await f.call(f.spend.getCategoryTransactionsSpec, {
          categoryId: null,
          from: 42,
          to: null,
        }),
        "INVALID",
      );
      expect(f.paths).toEqual([]);
    }),
  30000,
);

/** Tiny synthetic PDF; no private bank document or fixture is needed. */
function statementPdf() {
  const lines = [
    "Bank of Baroda",
    "Statement Period from October 01, 2026 to October 31, 2026",
    "900.001 01-10-2026 01-10-2026 Lunch 100.00 -",
  ];
  const stream = `BT /F1 10 Tf 40 750 Td 16 TL ${lines.map((s, i) => `${i ? "T* " : ""}(${s}) Tj`).join("\n")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

dbTest(
  "upload FormData: real PDF ingest, summary/links/counts and tenant isolation",
  () =>
    fixture(async (f) => {
      const { uploadStatementSpec } =
        await import("@/app/import/import-handlers");
      failure(await f.call(uploadStatementSpec, {}), "INVALID");
      failure(
        await f.call(uploadStatementSpec, new FormData()),
        "INVALID",
        "No file uploaded",
      );
      const fd = new FormData();
      fd.set(
        "file",
        new File([statementPdf()], "synthetic.pdf", {
          type: "application/pdf",
        }),
      );
      fd.set("accountId", f.otherAccount);
      fd.set("userId", f.other);
      const data = unwrap(await f.call(uploadStatementSpec, fd));
      expect(data).toMatchObject({
        bank: "bob",
        summary: { rowsSeen: 1, rowsNew: 1, rowsDuplicate: 0 },
        categorizedCount: 0,
        needsAttentionCount: 1,
        statementHref: "/transactions?from=2026-10-01&to=2026-10-31",
      });
      expect(data.reviewHref).toBe(
        `/transactions?import=${data.summary.importId}&attention=1&all=1`,
      );
      expect(
        (
          await f.db
            .select()
            .from(f.schema.imports)
            .where(eq(f.schema.imports.id, data.summary.importId))
        )[0].accountId,
      ).toBe(f.account);
      const rows = await f.db
        .select()
        .from(f.schema.transactions)
        .where(eq(f.schema.transactions.sourceImportId, data.summary.importId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        accountId: f.account,
        amountPaise: 10000,
      });
      expect(f.paths).toEqual(["/import", "/transactions", "/review"]);
    }),
  30000,
);

dbTest("connection tokens: create/list/revoke, validation and actor isolation", () => fixture(async (f) => {
  const a = await import("@/app/connections/connection-handlers");
  const created = unwrap(await f.call(a.createMcpTokenSpec, { name: " Test agent ", scope: "write", userId: f.other, accountId: f.otherAccount }));
  expect(created.token).toMatch(/^mny_/);
  expect(created.hint).toBeString();
  expect(created.id).toBeString();
  expect(Object.keys(created).sort()).toEqual(["hint", "id", "token"]);
  expect(unwrap(await f.call(a.listMcpTokensSpec, undefined))).toMatchObject([{ id: created.id, name: "Test agent", scope: "write", revokedAt: null }]);
  expect(unwrap(await f.call(a.listMcpTokensSpec, undefined, true))).toEqual([]);
  failure(await f.call(a.createMcpTokenSpec, 42), "INVALID", "Choose a name and a read, propose or write scope.");
  failure(await f.call(a.createMcpTokenSpec, { scope: "read" }), "INVALID", "Choose a name and a read, propose or write scope.");
  failure(await f.call(a.createMcpTokenSpec, { name: 42, scope: "read" }), "INVALID", "Choose a name and a read, propose or write scope.");
  failure(await f.call(a.createMcpTokenSpec, { name: " ", scope: "read" }), "INVALID", "Use a token name between 1 and 40 characters.");
  failure(await f.call(a.revokeMcpTokenSpec, { id: 42 }), "INVALID", "Choose a token first.");
  failure(await f.call(a.revokeMcpTokenSpec, { id: crypto.randomUUID() }), "NOT_FOUND", "That token isn't available.");
  failure(await f.call(a.revokeMcpTokenSpec, { id: created.id }, true), "NOT_FOUND", "That token isn't available.");
  expect(unwrap(await f.call(a.revokeMcpTokenSpec, { id: created.id }))).toBeUndefined();
  expect(unwrap(await f.call(a.revokeMcpTokenSpec, { id: created.id }))).toBeUndefined();
  expect(unwrap(await f.call(a.listMcpTokensSpec, undefined))[0].revokedAt).toBeString();
  // Creation ignores caller-supplied actor ids even in the other tenant.
  const otherToken = unwrap(await f.call(a.createMcpTokenSpec, { name: "Other agent", scope: "read", userId: f.user, accountId: f.account }, true));
  expect(unwrap(await f.call(a.listMcpTokensSpec, undefined)).some(r => r.id === otherToken.id)).toBe(false);
  expect(f.paths).toEqual([]);
}), 30000);

dbTest("ledger history: list/undo, foreign id, custom stale message and success-only revalidation", () => fixture(async (f) => {
  const a = await import("@/app/connections/connection-handlers");
  unwrap(await f.call(f.txns.setTransactionNoteSpec, { transactionId: f.debit, note: "One" }));
  const page = unwrap(await f.call(a.listLedgerChangesSpec, { before: 42 }));
  expect(page.available).toBe(true);
  expect(page.rows).toHaveLength(1);
  expect(unwrap(await f.call(a.listLedgerChangesSpec, undefined, true)).rows).toEqual([]);
  const changeId = page.rows[0].id;
  f.paths.length = 0;
  failure(await f.call(a.undoLedgerChangeSpec, { changeId: null }), "INVALID", "Choose a change first.");
  failure(await f.call(a.undoLedgerChangeSpec, { changeId }, true), "NOT_FOUND", "That change isn't available.");
  expect(f.paths).toEqual([]);
  expect(unwrap(await f.call(a.undoLedgerChangeSpec, { changeId }))).toBeUndefined();
  expect((await f.read()).note).toBeNull();
  expect(f.paths).toEqual(["/transactions", "/review", "/", "/timeline", "/connections", "/reimbursements", "/people", "/spend"]);
  failure(await f.call(a.undoLedgerChangeSpec, { changeId }), "CONFLICT", "That change was already undone.");
  unwrap(await f.call(f.txns.setTransactionNoteSpec, { transactionId: f.debit, note: "Two" }));
  const latest = unwrap(await f.call(a.listLedgerChangesSpec, undefined)).rows[0].id;
  await f.db.update(f.schema.transactions).set({ note: "Changed later" }).where(eq(f.schema.transactions.id, f.debit));
  f.paths.length = 0;
  failure(await f.call(a.undoLedgerChangeSpec, { changeId: latest }), "CONFLICT", "Nothing was undone. A target or its related shares, settlements or people changed after this change. Review the latest values first.");
  expect(f.paths).toEqual([]);
  expect((await f.read()).note).toBe("Changed later");
}), 30000);

dbTest("proposed drafts: open/resolve with original messages and foreign tenant refusal", () => fixture(async (f) => {
  const a = await import("@/app/assistant/proposed-tag-handlers");
  const draftId = crypto.randomUUID();
  await f.db.insert(f.schema.mcpTagDrafts).values({ id: draftId, userId: f.user, accountId: f.account, sourceLabel: "Test agent", title: "Review", rows: [{ transactionId: f.debit, categoryId: f.category, expectedCurrentCategoryId: null, confidence: "high", reason: "Test suggestion" }] });
  failure(await f.call(a.openProposedTagDraftSpec, { draftId: 42 }), "INVALID", "Choose a proposed draft first.");
  failure(await f.call(a.openProposedTagDraftSpec, { draftId }, true), "NOT_FOUND", "That pending draft isn't available.");
  const opened = unwrap(await f.call(a.openProposedTagDraftSpec, { draftId }));
  expect(opened).toMatchObject({ draftId, label: "Review · Test agent", sourceLabel: "Test agent", title: "Review", total: 1, changed: 0 });
  expect(opened.txns.map(t => t.id)).toEqual([f.debit]);
  expect((await f.read()).categoryId).toBeNull();
  failure(await f.call(a.resolveProposedTagDraftSpec, { draftId, status: "pending" }), "INVALID", "Choose a pending draft and an applied or dismissed status.");
  failure(await f.call(a.resolveProposedTagDraftSpec, { draftId, status: "dismissed" }, true), "NOT_FOUND", "That pending draft isn't available.");
  expect(unwrap(await f.call(a.resolveProposedTagDraftSpec, { draftId, status: "dismissed" }))).toBeUndefined();
  failure(await f.call(a.openProposedTagDraftSpec, { draftId }), "NOT_FOUND", "That pending draft isn't available.");
  expect(f.paths).toEqual([]);
}), 30000);

dbTest("context notes: save/update/delete/add/list, tolerances, warnings and foreign ids", () => fixture(async (f) => {
  const a = await import("@/app/assistant/tag-handlers");
  failure(await f.call(a.saveContextNoteSpec, { body: 42 }), "INVALID", "Write a note first.");
  failure(await f.call(a.addContextNoteSpec, { body: " " }), "INVALID", "Write a note first.");
  failure(await f.call(a.deleteContextNoteSpec, { id: 42 }), "NOT_FOUND", "That note isn't available.");
  const saved = unwrap(await f.call(a.saveContextNoteSpec, { body: "  Sample shop is Food  ", id: 42 }));
  expect(saved.note.body).toBe("Sample shop is Food");
  failure(await f.call(a.saveContextNoteSpec, { id: saved.note.id, body: "Other" }, true), "NOT_FOUND", "That note isn't available.");
  // Main silently succeeds for an unknown/foreign note; it must leave the row intact.
  expect(unwrap(await f.call(a.deleteContextNoteSpec, { id: saved.note.id }, true))).toBeUndefined();
  expect(unwrap(await f.call(a.listContextNotesActionSpec, undefined, true))).toEqual([]);
  expect(unwrap(await f.call(a.saveContextNoteSpec, { id: saved.note.id, body: "New text" })).note.body).toBe("New text");
  const warned = unwrap(await f.call(a.saveContextNoteSpec, { body: "Details 12345" }));
  expect(warned.warning).toBeString();
  const added = unwrap(await f.call(a.addContextNoteSpec, { body: "x".repeat(600), userId: f.other, accountId: f.otherAccount }));
  const notes = unwrap(await f.call(a.listContextNotesActionSpec, undefined));
  expect(notes).toHaveLength(3);
  expect(notes.find(n => n.id === added.id)?.body).toHaveLength(500);
  const other = unwrap(await f.call(a.addContextNoteSpec, { body: "Other tenant", userId: f.user }, true));
  expect(unwrap(await f.call(a.listContextNotesActionSpec, undefined)).some(n => n.id === other.id)).toBe(false);
  expect(unwrap(await f.call(a.deleteContextNoteSpec, { id: saved.note.id }))).toBeUndefined();
  expect(unwrap(await f.call(a.listContextNotesActionSpec, undefined))).toHaveLength(2);
  expect(f.paths).toEqual([]);
}), 30000);

dbTest("tag suggestions: stub, loose offset, validation and tenant-scoped snapshots", () => fixture(async (f) => {
  const a = await import("@/app/assistant/tag-handlers");
  const previous = process.env.MONEY_TAG_SUGGEST_STUB;
  process.env.MONEY_TAG_SUGGEST_STUB = "1";
  try {
    failure(await f.call(a.suggestTagChunkSpec, { year: "2026", month: 10, offset: 0 }), "INVALID", "Pick a month to tag.");
    const draft = unwrap(await f.call(a.suggestTagChunkSpec, { year: 2026, month: 10, offset: "not a number" }));
    expect(draft).toMatchObject({ label: "Oct 2026", total: 3, suggester: "stub", nextOffset: null });
    expect(draft.txns.some(t => t.id === f.foreign)).toBe(false);
    expect(draft.rows.every(r => !r.selected)).toBe(true);
    const other = unwrap(await f.call(a.suggestTagChunkSpec, { year: 2026, month: 10, offset: null, ids: [f.debit] }, true));
    expect(other.txns.map(t => t.id)).toEqual([f.foreign]);
    expect((await f.read()).categoryId).toBeNull();
    expect(f.paths).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.MONEY_TAG_SUGGEST_STUB; else process.env.MONEY_TAG_SUGGEST_STUB = previous;
  }
}), 30000);

dbTest("tag apply/undo: stale and foreign rows, sanitizers, overflow and conditional revalidation", () => fixture(async (f) => {
  const a = await import("@/app/assistant/tag-handlers");
  const row = { transactionId: f.debit, categoryId: f.category, expectedCurrentCategoryId: null };
  const empty = unwrap(await f.call(a.applySuggestedTagsSpec, { rows: [null, {}, 42, { transactionId: 42, categoryId: f.category }] }));
  expect(empty).toEqual({ applied: [], failed: [], skipped: 0 });
  expect(f.paths).toEqual([]);
  const applied = unwrap(await f.call(a.applySuggestedTagsSpec, { rows: [row, { ...row, transactionId: f.foreign }] }));
  expect(applied.applied).toHaveLength(1);
  expect(applied.failed).toHaveLength(1);
  expect(f.paths).toEqual(["/transactions", "/review", "/", "/timeline", "/connections"]);
  f.paths.length = 0;
  const stale = unwrap(await f.call(a.applySuggestedTagsSpec, { rows: [row] }));
  expect(stale.failed[0].reason).toBe("The category changed since this card was made. Ask again to get a fresh card.");
  expect(f.paths).toEqual([]);
  const foreignApply = unwrap(await f.call(a.applySuggestedTagsSpec, { rows: [row] }, true));
  expect(foreignApply.failed).toHaveLength(1);
  expect(unwrap(await f.call(a.undoSuggestedTagsSpec, { rows: applied.applied }, true))).toEqual({ restored: 0, failed: 1 });
  expect(unwrap(await f.call(a.undoSuggestedTagsSpec, { rows: [row] }))).toEqual({ restored: 0, failed: 1 });
  expect(f.paths).toEqual([]);
  expect(unwrap(await f.call(a.undoSuggestedTagsSpec, { rows: applied.applied }))).toEqual({ restored: 1, failed: 0 });
  expect((await f.read()).categoryId).toBeNull();
  expect(f.paths).toEqual(["/transactions", "/review", "/", "/timeline", "/connections"]);
  f.paths.length = 0;
  expect(unwrap(await f.call(a.undoSuggestedTagsSpec, { rows: applied.applied }))).toEqual({ restored: 0, failed: 1 });
  const overflow = unwrap(await f.call(a.applySuggestedTagsSpec, { rows: Array.from({ length: 402 }, () => row) }));
  expect(overflow.applied).toHaveLength(1);
  expect(overflow.failed.filter(r => r.reason === "Only 50 rows can be saved at a time.")).toHaveLength(350);
  expect(overflow.applied.length + overflow.failed.length).toBe(400); // main ignores rows after 400
  f.paths.length = 0;
  expect(unwrap(await f.call(a.undoSuggestedTagsSpec, { rows: Array.from({ length: 52 }, () => row) }))).toEqual({ restored: 0, failed: 52 });
  expect(f.paths).toEqual([]);
}), 30000);

dbTest("payee defaults: first default, confirmation data, guarded replacement and foreign ids", () => fixture(async (f) => {
  const a = await import("@/app/assistant/tag-handlers");
  const second = crypto.randomUUID();
  await f.db.insert(f.schema.categories).values({ id: second, userId: f.user, name: "Other", kind: "spend" });
  failure(await f.call(a.rememberPayeeDefaultSpec, { counterpartyId: 42, categoryId: f.category }), "INVALID", "Pick a payee and a category.");
  failure(await f.call(a.rememberPayeeDefaultSpec, { counterpartyId: f.payee, categoryId: f.foreignCategory }), "NOT_FOUND", "That payee or category isn't available.");
  failure(await f.call(a.rememberPayeeDefaultSpec, { counterpartyId: f.payee, categoryId: f.foreignCategory }, true), "NOT_FOUND", "That payee or category isn't available.");
  expect(unwrap(await f.call(a.rememberPayeeDefaultSpec, { counterpartyId: f.payee, categoryId: f.category }))).toEqual({});
  const confirm = unwrap(await f.call(a.rememberPayeeDefaultSpec, { counterpartyId: f.payee, categoryId: second }));
  expect(confirm).toEqual({ confirm: true, existingCategoryId: f.category, existingCategoryName: "Food", nextCategoryName: "Other" });
  expect(unwrap(await f.call(a.rememberPayeeDefaultSpec, { counterpartyId: f.payee, categoryId: second, confirmFromCategoryId: f.category }))).toEqual({});
  expect((await f.db.select().from(f.schema.counterparties).where(eq(f.schema.counterparties.id, f.payee)))[0].defaultCategoryId).toBe(second);
  expect((await f.read()).categoryId).toBeNull();
  expect(f.paths).toEqual([]);
}), 30000);

dbTest("assistant apply-to-all preview: all messages, successful draft and foreign id", () => fixture(async (f) => {
  const a = await import("@/app/assistant/assistant-handlers");
  failure(await f.call(a.prepareApplyToAllSpec, { txnId: f.foreign }), "NOT_FOUND", "That transaction isn't available.");
  failure(await f.call(a.prepareApplyToAllSpec, { txnId: 42 }), "NOT_FOUND", "That transaction isn't available.");
  failure(await f.call(a.prepareApplyToAllSpec, { txnId: f.debit }, true), "NOT_FOUND", "That transaction isn't available.");
  failure(await f.call(a.prepareApplyToAllSpec, { txnId: f.debit }), "INVALID", "Set a category on this payment first.");
  await f.db.update(f.schema.transactions).set({ categoryId: f.category, counterpartyId: null }).where(eq(f.schema.transactions.id, f.debit));
  failure(await f.call(a.prepareApplyToAllSpec, { txnId: f.debit }), "INVALID", "This payment has no recognised payee to match others by.");
  await f.db.update(f.schema.transactions).set({ counterpartyId: f.payee }).where(eq(f.schema.transactions.id, f.debit));
  expect(unwrap(await f.call(a.prepareApplyToAllSpec, { txnId: f.debit }))).toEqual({ draft: { op: "cat_all", txnId: f.debit, categoryId: f.category, payee: "Kiran", count: 2 } });
  await f.db.update(f.schema.transactions).set({ categoryId: f.category }).where(inArray(f.schema.transactions.id, [f.credit, f.sibling]));
  failure(await f.call(a.prepareApplyToAllSpec, { txnId: f.debit }), "INVALID", "No other uncategorized payments from this payee.");
  expect(f.paths).toEqual([]);
}), 30000);

dbTest("assistant cards/reads/bootstrap: drafts, no guessed person and foreign ids dropped", () => fixture(async (f) => {
  const a = await import("@/app/assistant/assistant-handlers");
  const tag = await import("@/app/assistant/tag-handlers");
  for (const kind of ["note", "split", "net"]) {
    failure(await f.call(a.prepareAssistantOpSpec, { kind, txnId: f.foreign }), "NOT_FOUND", "That transaction isn't available.");
    failure(await f.call(a.prepareAssistantOpSpec, { kind, txnId: f.debit }, true), "NOT_FOUND", "That transaction isn't available.");
  }
  expect(unwrap(await f.call(a.prepareAssistantOpSpec, { kind: "note", txnId: f.debit }))).toMatchObject({ draft: { op: "note", note: "", currentNote: null, txnId: f.debit } });
  expect(unwrap(await f.call(a.prepareAssistantOpSpec, { kind: "split", txnId: f.debit }))).toMatchObject({ draft: { op: "split", parts: [{ name: "", amt: "", known: false }] } });
  failure(await f.call(a.prepareAssistantOpSpec, { kind: "split", txnId: f.credit }), "INVALID", "Only a payment you made can be split. Money you received can be net settled instead.");
  failure(await f.call(a.prepareAssistantOpSpec, { kind: "net", txnId: f.credit }), "INVALID", "I can't tell who sent this. Ask me, e.g. \"Nitin sent me this — net settle it\".");
  expect(unwrap(await f.call(a.loadAssistantTxnsSpec, { ids: [f.debit, f.foreign, 42, null] })).map(t => t.id)).toEqual([f.debit]);
  expect(unwrap(await f.call(a.loadAssistantTxnsSpec, { ids: [f.debit, f.foreign] }, true)).map(t => t.id)).toEqual([f.foreign]);
  expect(unwrap(await f.call(a.loadAssistantTxnsSpec, { ids: 42 }))).toEqual([]);
  const note = unwrap(await f.call(tag.addContextNoteSpec, { body: "Sample context" }));
  const boot = unwrap(await f.call(a.getAssistantBootstrapSpec, undefined));
  expect(boot).toMatchObject({ aiState: "off", accountName: "Test", contextNotes: [{ id: note.id, body: "Sample context" }], proposedDrafts: [] });
  expect(boot.categories.map(c => c.id)).toEqual([f.category]);
  const other = unwrap(await f.call(a.getAssistantBootstrapSpec, undefined, true));
  expect(other.contextNotes).toEqual([]);
  expect(other.categories.map(c => c.id)).toEqual([f.foreignCategory]);
  expect(f.paths).toEqual([]);
  await f.makeShare();
  failure(await f.call(a.prepareAssistantOpSpec, { kind: "split", txnId: f.debit }), "CONFLICT", "This payment already has a split. Edit it from the Split button in the table so existing settlements aren't lost.");
}), 30000);

dbTest("assistant turn: empty, rules find, tag June, permissive history and foreign focus", () => fixture(async (f) => {
  const a = await import("@/app/assistant/assistant-handlers");
  failure(await f.call(a.assistantTurnSpec, { message: " \n ", history: null, focusTxnId: null }), "INVALID", "Type something to ask.");
  const history = [null, { role: "bad", text: "bad" }, ...Array.from({ length: 25 }, () => ({ role: "user", text: "x".repeat(700) }))];
  const found = unwrap(await f.call(a.assistantTurnSpec, { message: "  Find the ₹40 payment  ", history, focusTxnId: f.foreign, resumedAfterPick: "yes", focusPicked: 1 }));
  expect(found.reader).toBe("rules");
  expect(found.focusTxnId).not.toBe(f.foreign);
  expect(found.txns.map(t => t.id)).toContain(f.credit);
  const tagged = unwrap(await f.call(a.assistantTurnSpec, { message: "tag June 2026", history: 42, focusTxnId: f.foreign }));
  expect(tagged).toMatchObject({ reader: "rules", txns: [], focusTxnId: null, limits: null });
  expect(tagged.messages).toContainEqual({ kind: "tag_run", year: 2026, month: 6 });
  const other = unwrap(await f.call(a.assistantTurnSpec, { message: "tag June 2026", history: [], focusTxnId: f.debit }, true));
  expect(other.focusTxnId).toBeNull();
  expect(f.paths).toEqual([]);
}), 30000);

dbTest("every migrated assistant/connection spec authenticates before input decoding", () => fixture(async (f) => {
  const { Unauthenticated } = await import("@/lib/action/errors");
  const connection = await import("@/app/connections/connection-handlers");
  const draft = await import("@/app/assistant/proposed-tag-handlers");
  const assistant = await import("@/app/assistant/assistant-handlers");
  const tag = await import("@/app/assistant/tag-handlers");
  const specs = [connection.listMcpTokensSpec, connection.createMcpTokenSpec, connection.revokeMcpTokenSpec,
    connection.listLedgerChangesSpec, connection.undoLedgerChangeSpec, draft.openProposedTagDraftSpec, draft.resolveProposedTagDraftSpec,
    assistant.getAssistantBootstrapSpec, assistant.assistantTurnSpec, assistant.loadAssistantTxnsSpec, assistant.prepareAssistantOpSpec, assistant.prepareApplyToAllSpec,
    tag.listContextNotesActionSpec, tag.saveContextNoteSpec, tag.deleteContextNoteSpec, tag.addContextNoteSpec, tag.suggestTagChunkSpec, tag.applySuggestedTagsSpec, tag.undoSuggestedTagsSpec, tag.rememberPayeeDefaultSpec];
  expect(specs).toHaveLength(20);
  const anonymous = Layer.merge(Layer.effect(CurrentUser, Effect.fail(new Unauthenticated())), Layer.succeed(Db, f.db));
  let decoded = false;
  const raw = Object.defineProperty({}, "message", { enumerable: true, get() { decoded = true; throw new Error("Input decoded before auth"); } });
  // Each concrete spec keeps its own input/output types; the union needs no test casts.
  for (const spec of specs) {
    const result = await runAction({ input: spec.input, handler: () => { throw new Error("Handler ran without auth"); } }, raw,
      { name: "anonymous-action", layer: anonymous });
    failure(result, "UNAUTHENTICATED", "Your session has ended. Sign in again.");
  }
  expect(decoded).toBe(false);
}), 30000);

dbTest(
  "registration: public FormData validation, duplicate email, real hash/insert/categories and redirect",
  () =>
    fixture(async (f) => {
      // Only framework request/session boundaries are stubbed. DB, password hashing
      // and category creation are real. These mocks are never installed by unit runs.
      const { mock } = await import("bun:test");
      const { hashPassword } = await import("@/lib/password");
      const { default: bcrypt } = await import("bcryptjs");
      const signed: unknown[] = [];
      mock.module("next/headers", () => ({
        headers: async () => new Headers({ "x-real-ip": "127.0.0.1" }),
        cookies: async () => ({}),
      }));
      mock.module("@/lib/rate-limit", () => ({
        checkRegisterRateLimit: async () => true,
      }));
      mock.module("@/auth", () => ({
        hashPassword,
        signIn: async (...args: unknown[]) => {
          signed.push(args);
        },
      }));
      const { redirect } = await import("next/dist/client/components/redirect");
      mock.module("next/navigation", () => ({ redirect }));
      const { registerUserSpec } = await import("@/app/auth/register-handler");
      const call = (raw: unknown) =>
        runAction(registerUserSpec, raw, {
          name: "register-db-test",
          layer: Layer.succeed(Db, f.db),
          rethrow: (e) => {
            throw e;
          },
        });
      const fd = new FormData();
      failure(await call({}), "INVALID");
      failure(await call(fd), "INVALID", "Enter a valid email address.");
      fd.set("email", `${f.user}@actions.test`);
      fd.set("password", "a sufficiently long password");
      fd.set("confirm", "different");
      failure(await call(fd), "INVALID", "Passwords do not match.");
      fd.set("confirm", "a sufficiently long password");
      failure(
        await call(fd),
        "CONFLICT",
        "An account with this email already exists.",
      );
      const email = `${crypto.randomUUID()}@actions.test`;
      fd.set("email", ` ${email.toUpperCase()} `);
      fd.set("name", " Meera ");
      try {
        await expect(call(fd)).rejects.toMatchObject({
          digest: expect.stringContaining("NEXT_REDIRECT"),
        });
        const [created] = await f.db
          .select()
          .from(f.schema.users)
          .where(eq(f.schema.users.email, email));
        expect(created).toMatchObject({ name: "Meera", tokenVersion: 0 });
        expect(
          await bcrypt.compare(
            "a sufficiently long password",
            created.passwordHash!,
          ),
        ).toBe(true);
        expect(
          (
            await f.db
              .select()
              .from(f.schema.categories)
              .where(eq(f.schema.categories.userId, created.id))
          ).length,
        ).toBeGreaterThan(0);
        expect(signed).toEqual([
          [
            "credentials",
            {
              email,
              password: "a sufficiently long password",
              redirect: false,
            },
          ],
        ]);
      } finally {
        await f.db
          .delete(f.schema.users)
          .where(eq(f.schema.users.email, email));
        mock.restore();
      }
    }),
  30000,
);

// These framework-boundary mocks run last; all rules/DB behavior above is real.
dbTest("assistant sanitization and validation/rate ordering retain main's limits and messages", () => fixture(async (f) => {
  const { mock } = await import("bun:test");
  const assistant = await import("@/app/assistant/assistant-handlers");
  const tag = await import("@/app/assistant/tag-handlers");
  const agentModule = await import("@/lib/assistant/agent");
  const realAgent = { runAgentTurn: agentModule.runAgentTurn, runRulesTurn: agentModule.runRulesTurn };
  const rateModule = await import("@/lib/rate-limit");
  const realRate = { ...rateModule };
  let seen: import("@/lib/assistant/agent").TurnContext | undefined;
  let allowed = true;
  let rateCalls = 0;
  mock.module("@/lib/assistant/agent", () => ({
    ...realAgent,
    runRulesTurn: async (ctx: import("@/lib/assistant/agent").TurnContext) => {
      seen = ctx;
      return { messages: [], txnIds: [], focusTxnId: ctx.focusTxnId, limits: null };
    },
  }));
  mock.module("@/lib/rate-limit", () => ({ ...realRate, checkAssistantRateLimit: async () => { rateCalls++; return allowed; } }));
  try {
    const valid = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `${i}:` + "x".repeat(700) }));
    // Invalid tail entries must be filtered BEFORE taking the last twenty.
    unwrap(await f.call(assistant.assistantTurnSpec, { message: " " + "q".repeat(1100) + " ", history: [...valid, ...Array(25).fill(null)], focusTxnId: f.foreign }));
    expect(seen?.message).toBe("q".repeat(1000));
    expect(seen?.history).toEqual(valid.slice(-20).map(h => ({ ...h, text: h.text.slice(0, 600) })));
    expect(seen?.focusTxnId).toBeNull();
    allowed = false;
    rateCalls = 0;
    failure(await f.call(assistant.assistantTurnSpec, { message: " " }), "INVALID", "Type something to ask.");
    failure(await f.call(tag.suggestTagChunkSpec, { year: 2026, month: 42 }), "INVALID", "Pick a month to tag.");
    expect(rateCalls).toBe(0);
    failure(await f.call(assistant.assistantTurnSpec, { message: "Find a payment" }), "UNAVAILABLE", "Too many requests in a short time. Try again in a few minutes.");
    failure(await f.call(tag.suggestTagChunkSpec, { year: 2026, month: 10, offset: 0 }), "UNAVAILABLE", "Too many requests in a short time. Try again in a few minutes.");
    expect(rateCalls).toBe(2);
  } finally {
    mock.module("@/lib/assistant/agent", () => realAgent);
    mock.module("@/lib/rate-limit", () => realRate);
    mock.restore();
  }
}), 30000);

dbTest('shared settlement policy: guarded replace, append, receipts, cash refusals and Effect undo', () => fixture(async f => {
  const share = await f.makeShare();
  const actor = { userId: f.user, accountId: f.account };
  const tokenId = crypto.randomUUID();
  await f.db.insert(f.schema.mcpTokens).values({ id: tokenId, userId: f.user, accountId: f.account, name: 'Policy agent', tokenHash: crypto.randomUUID(), tokenHint: 'mny_test', scope: 'write', userTokenVersion: 0 });
  const principal = { actor, tokenId, scope: 'write' as const, label: 'Policy agent' };
  const { mcpRelationalWrite } = await import('@/lib/mcp/relational-write-ops');
  const refs = await import('@/lib/mcp/refs');
  const { undoChange } = await import('@/lib/ledger/undo');
  const oldSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = 'settlement-policy-test-secret';
  try {
    const key = refs.deriveMcpRefKey(process.env.AUTH_SECRET);
    const inflow_ref = refs.transactionRef(key, f.user, f.credit);
    const share_ref = refs.shareRef(key, f.user, f.account, share.id);
    const rows = [{ splitParticipantId: share.id, amountPaise: 1000 }];
    const initial = unwrap(await f.call(f.split.recordSettlementSpec, { inflowTransactionId: f.credit, allocations: rows, expectedAllocations: [] }));
    expect(initial).toMatchObject({ appliedPaise: 1000, stillOpenPaise: 5000, unallocatedPaise: 3000 });
    const fresh = await f.call(f.split.recordSettlementSpec, { inflowTransactionId: f.credit, allocations: rows, expectedAllocations: rows });
    expect(fresh.ok).toBe(true);
    const [prior] = await f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.inflowTransactionId, f.credit));
    const appended = await mcpRelationalWrite(principal, 'record_settlement', { inflow_ref, person: 'Kiran', allocations: [{ share_ref, amount: '10' }], idempotency_key: 'policy-append-1' });
    expect(appended).toMatchObject({ applied: true, unallocated: '20.00', left_open: '40.00' });
    const before = await f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.inflowTransactionId, f.credit));
    expect(before.find(r => r.id === prior.id)).toEqual(prior);
    failure(await f.call(f.split.recordSettlementSpec, { inflowTransactionId: f.credit, allocations: rows, expectedAllocations: rows }), 'CONFLICT', "This payment's allocations changed since you opened it. Reload and review.");
    expect(await f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.inflowTransactionId, f.credit))).toEqual(before);
    // Reset through the app, then compare the same allocation's receipt at each door.
    unwrap(await f.call(f.split.clearSettlementSpec, { inflowTransactionId: f.credit }));
    const mcp = await mcpRelationalWrite(principal, 'record_settlement', { inflow_ref, person: 'Kiran', allocations: [{ share_ref, amount: '10' }], idempotency_key: 'policy-same-receipt' });
    expect(mcp).toMatchObject({ applied: true, allocations: [{ share_ref, person: initial.applied[0].personName, amount: '10.00', left: '50.00' }], unallocated: '30.00', left_open: '50.00' });
    const undo = await undoChange({ actor, source: 'app' }, String(mcp.change_id));
    expect(undo.changeId).toBeTruthy();
    const redo = await undoChange({ actor, source: 'app' }, undo.changeId!);
    expect(redo.changeId).toBeTruthy();
    unwrap(await f.call(f.split.clearSettlementSpec, { inflowTransactionId: f.credit }));
    // With no allocations specified the MCP core computes oldest-first under locks.
    const oldest = await mcpRelationalWrite(principal, 'record_settlement', { inflow_ref, person: ' kiran ', idempotency_key: 'policy-oldest-first' });
    expect(oldest).toMatchObject({ applied: true, allocations: [{ amount: '40.00', left: '20.00' }], unallocated: '0.00' });
    for (const [index, amountPaise] of [2001, 0, -1, 1.5].entries()) {
      const app = await f.call(f.cash.recordCashSettlementSpec, { splitParticipantId: share.id, amountPaise, note: null });
      expect(app.ok).toBe(false);
      const agent = await mcpRelationalWrite(principal, 'record_cash_settlement', { share_ref, amount: String(amountPaise / 100), idempotency_key: `policy-bad-cash-${index}` });
      expect(agent.applied).toBe(false);
    }
    const exact = unwrap(await f.call(f.cash.recordCashSettlementSpec, { splitParticipantId: share.id, amountPaise: 2000, note: null }));
    expect(exact).toEqual({ appliedPaise: 2000, leftPaise: 0 });
    failure(await f.call(f.cash.recordCashSettlementSpec, { splitParticipantId: share.id, amountPaise: 1, note: null }), 'INVALID', 'Nothing is open on this share.');
    expect(await mcpRelationalWrite(principal, 'record_cash_settlement', { share_ref, amount: '0.01', idempotency_key: 'policy-zero-open' })).toMatchObject({ applied: false, errors: [{ code: 'over_allocation', message: 'Nothing is open on this share.' }] });
    // Reset cash via its log and prove the MCP exact-fit path too.
    const [cashLog] = (await f.db.select().from(f.schema.ledgerChanges).where(eq(f.schema.ledgerChanges.userId, f.user))).filter(r => r.kind === 'record_cash_settlement');
    await undoChange({ actor, source: 'app' }, cashLog.id);
    expect(await mcpRelationalWrite(principal, 'record_cash_settlement', { share_ref, amount: '20', idempotency_key: 'policy-exact-cash' })).toMatchObject({ applied: true });
  } finally {
    if (oldSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = oldSecret;
  }
}), 30000);

// These tests exercise the real defineAction and MCP adapter boundaries: a Die
// exit must never masquerade as the expected INVALID/CONFLICT refusal.
dbTest('net refusal codes and exact messages survive both doors', () => fixture(async f => {
  const share = await f.makeShare();
  const owedExpenseId = unwrap(await f.call(f.owed.createOwedExpenseSpec, { personName: 'Finch', incurredDate: '2026-10-03', amountPaise: 20000, description: 'Test bill' }));
  const { mcpRelationalWrite } = await import('@/lib/mcp/relational-write-ops');
  const refs = await import('@/lib/mcp/refs');
  const { indiaTodayIso } = await import('@/lib/dates/india');
  const oldSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = 'net-refusal-test-secret';
  try {
    const actor = { userId: f.user, accountId: f.account }, tokenId = crypto.randomUUID();
    await f.db.insert(f.schema.mcpTokens).values({ id: tokenId, userId: f.user, accountId: f.account, name: 'Refusal test', tokenHash: crypto.randomUUID(), tokenHint: 'mny_test', scope: 'write', userTokenVersion: 0 });
    const principal = { actor, scope: 'write' as const, tokenId, label: 'Refusal test' };
    const key = refs.deriveMcpRefKey(process.env.AUTH_SECRET);
    const txRef = (id: string) => refs.transactionRef(key, f.user, id);
    type Input = Parameters<typeof import('@/lib/ledger/net-events').saveNetEvent>[1];
    const bank = { kind: 'receivable' as const, splitParticipantId: share.id, amountPaise: 4000, method: 'bank' as const, expectedOutstandingPaise: 6000 };
    const cases: Array<{ name: string; code: 'invalid_input' | 'invalid_amount' | 'stale'; message: string; input: Input; explained?: boolean; unsafe?: boolean }> = [
      { name: 'unsafe outstanding', code: 'invalid_amount', message: 'Balance exceeds the exact integer paise range.', unsafe: true, input: { legs: [{ ...bank, method: 'cash' }] } },
      { name: 'stale outstanding', code: 'stale', message: 'A balance changed since you opened this settlement. Refresh and review it again.', input: { inflowTransactionId: f.credit, legs: [{ ...bank, expectedOutstandingPaise: 5999 }] } },
      { name: 'stale payable outstanding', code: 'stale', message: 'A balance changed since you opened this settlement. Refresh and review it again.', input: { legs: [{ kind: 'payable', owedExpenseId, method: 'cash', amountPaise: 2000, expectedOutstandingPaise: 19999 }] } },
      { name: 'conflicting payable guards', code: 'invalid_input', message: 'Conflicting balance previews for the same bill.', input: { legs: [{ kind: 'payable', owedExpenseId, method: 'cash', amountPaise: 2000, expectedOutstandingPaise: 20000 }, { kind: 'payable', owedExpenseId, method: 'cash', amountPaise: 2000, expectedOutstandingPaise: 19999 }] } },
      { name: 'payable cap', code: 'invalid_input', message: 'Combined payable legs exceed outstanding by 0.01', input: { legs: [{ kind: 'payable', owedExpenseId, method: 'cash', amountPaise: 20001, expectedOutstandingPaise: 20000 }] } },
      { name: 'conflicting duplicate guards', code: 'invalid_input', message: 'Conflicting balance previews for the same bill.', input: { inflowTransactionId: f.credit, legs: [{ ...bank, amountPaise: 2000 }, { ...bank, amountPaise: 2000, expectedOutstandingPaise: 5999 }] } },
      { name: 'past cash date', code: 'invalid_input', message: "Cash settlements use today's date. Set the date to today or leave it empty.", input: { eventDate: '2000-01-01', legs: [{ ...bank, method: 'cash' }] } },
      { name: 'future cash date', code: 'invalid_input', message: "Cash settlements use today's date. Set the date to today or leave it empty.", input: { eventDate: '2099-01-01', legs: [{ ...bank, method: 'cash' }] } },
      { name: 'cash with inflow', code: 'invalid_input', message: 'Cash settlements cannot also use a bank payment.', input: { inflowTransactionId: f.credit, legs: [{ ...bank, method: 'cash' }] } },
      { name: 'cash with outflow', code: 'invalid_input', message: 'Cash settlements cannot also use a bank payment.', input: { outflowTransactionId: f.debit, legs: [{ ...bank, method: 'cash' }] } },
      { name: 'wrong inflow direction', code: 'invalid_input', message: 'The bank payment has the wrong direction. Refresh and choose another payment.', input: { inflowTransactionId: f.debit, legs: [bank] } },
      { name: 'wrong outflow direction', code: 'invalid_input', message: 'The bank payment has the wrong direction. Refresh and choose another payment.', input: { outflowTransactionId: f.credit, legs: [{ kind: 'payable', owedExpenseId, method: 'offset', amountPaise: 4000, expectedOutstandingPaise: 20000 }] } },
      { name: 'split bill outflow', code: 'invalid_input', message: 'This bank payment is already a split bill. Choose a separate settlement payment.', input: { outflowTransactionId: f.debit, legs: [{ kind: 'payable', owedExpenseId, method: 'offset', amountPaise: 10000, expectedOutstandingPaise: 20000 }] } },
      { name: 'explained inflow', code: 'stale', message: 'This payment is already allocated or explained elsewhere. Refresh and review its settlement first.', explained: true, input: { inflowTransactionId: f.credit, legs: [bank] } },
      { name: 'empty legs', code: 'invalid_input', message: 'At least one non-zero leg is required', input: { legs: [] } },
      { name: 'bank leg without inflow', code: 'invalid_input', message: 'Bank receivable legs require an inflow transaction', input: { legs: [bank] } },
      { name: 'bank reconciliation', code: 'invalid_input', message: 'Net 39.99 does not match bank delta 40', input: { inflowTransactionId: f.credit, legs: [{ ...bank, amountPaise: 3999 }] } },
      { name: 'combined target cap', code: 'invalid_input', message: 'Combined receivable legs exceed outstanding by 10', input: { legs: [{ ...bank, amountPaise: 7000, method: 'cash' }] } },
    ];
    for (const [i, row] of cases.entries()) {
      if (row.unsafe) await f.db.update(f.schema.splitParticipants).set({ expectedAmountPaise: Number.MAX_SAFE_INTEGER + 1 }).where(eq(f.schema.splitParticipants.id, share.id));
      if (row.explained) await f.db.update(f.schema.transactions).set({ residualDisposition: 'kept', residualAcknowledgedPaise: 1000 }).where(eq(f.schema.transactions.id, f.credit));
      f.paths.length = 0;
      expect(await f.call(f.net.saveNetEventSpec, row.input), row.name).toEqual({ ok: false, code: row.code === 'stale' ? 'CONFLICT' : 'INVALID', message: row.message });
      const receivables = row.input.legs.flatMap(l => l.kind === 'receivable' ? [{ share_ref: refs.shareRef(key, f.user, f.account, l.splitParticipantId), amount: (l.amountPaise / 100).toFixed(2), method: l.method, expected_outstanding: (l.expectedOutstandingPaise! / 100).toFixed(2) }] : []);
      const payables = row.input.legs.flatMap(l => l.kind === 'payable' ? [{ owed_ref: refs.owedRef(key, f.user, f.account, l.owedExpenseId!), amount: (l.amountPaise / 100).toFixed(2), method: l.method, expected_outstanding: (l.expectedOutstandingPaise! / 100).toFixed(2) }] : []);
      const agent = await mcpRelationalWrite(principal, 'net_settle', { receivables, payables, date: row.input.eventDate ?? indiaTodayIso(), ...(row.input.inflowTransactionId ? { inflow_ref: txRef(row.input.inflowTransactionId) } : {}), ...(row.input.outflowTransactionId ? { outflow_ref: txRef(row.input.outflowTransactionId) } : {}), idempotency_key: `refusal-net-${i}` });
      expect(agent, row.name).toEqual({ applied: false, errors: [{ code: row.code, message: row.message }] });
      expect(f.paths, row.name).toEqual([]);
      if (row.unsafe) await f.db.update(f.schema.splitParticipants).set({ expectedAmountPaise: 6000 }).where(eq(f.schema.splitParticipants.id, share.id));
      if (row.explained) await f.db.update(f.schema.transactions).set({ residualDisposition: null, residualAcknowledgedPaise: null }).where(eq(f.schema.transactions.id, f.credit));
    }
    expect(await f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.splitParticipantId, share.id))).toEqual([]);
  } finally {
    if (oldSecret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = oldSecret;
  }
}), 30000);

dbTest('cash refusal codes and exact messages survive both doors', () => fixture(async f => {
  const share = await f.makeShare();
  const { mcpRelationalWrite } = await import('@/lib/mcp/relational-write-ops');
  const refs = await import('@/lib/mcp/refs');
  const oldSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = 'cash-refusal-test-secret';
  try {
    const actor = { userId: f.user, accountId: f.account }, tokenId = crypto.randomUUID();
    await f.db.insert(f.schema.mcpTokens).values({ id: tokenId, userId: f.user, accountId: f.account, name: 'Cash refusals', tokenHash: crypto.randomUUID(), tokenHint: 'mny_test', scope: 'write', userTokenVersion: 0 });
    const principal = { actor, scope: 'write' as const, tokenId, label: 'Cash refusals' };
    const share_ref = refs.shareRef(refs.deriveMcpRefKey(process.env.AUTH_SECRET), f.user, f.account, share.id);
    const schemaMessage = "Use the tool's documented fields, exact decimal rupees and idempotency key.";
    const cases = [
      { amountPaise: 0, amount: '0', cap: 6000, appMessage: 'Enter an amount above ₹0.00.', code: 'invalid_input', message: schemaMessage },
      { amountPaise: -1, amount: '-0.01', cap: 6000, appMessage: 'Enter an amount above ₹0.00.', code: 'invalid_input', message: schemaMessage },
      { amountPaise: 1.5, amount: '0.015', cap: 6000, appMessage: 'Enter an amount above ₹0.00.', code: 'invalid_input', message: schemaMessage },
      { amountPaise: 6001, amount: '60.01', cap: 6000, appMessage: '₹60.00 is still open; record ₹60.00 or less.', code: 'over_allocation', message: '₹60.00 is still open; record ₹60.00 or less.' },
      { amountPaise: 1, amount: '0.01', cap: 0, appMessage: 'Nothing is open on this share.', code: 'over_allocation', message: 'Nothing is open on this share.' },
      { amountPaise: 1, amount: '0.01', cap: Number.MAX_SAFE_INTEGER + 1, appMessage: 'Balance exceeds the exact integer paise range.', code: 'invalid_amount', message: 'Balance exceeds the exact integer paise range.' },
    ];
    for (const [i, row] of cases.entries()) {
      await f.db.update(f.schema.splitParticipants).set({ expectedAmountPaise: row.cap }).where(eq(f.schema.splitParticipants.id, share.id));
      f.paths.length = 0;
      expect(await f.call(f.cash.recordCashSettlementSpec, { splitParticipantId: share.id, amountPaise: row.amountPaise })).toEqual({ ok: false, code: 'INVALID', message: row.appMessage });
      expect(await mcpRelationalWrite(principal, 'record_cash_settlement', { share_ref, amount: row.amount, idempotency_key: `cash-refusal-${i}` })).toEqual({ applied: false, errors: [{ code: row.code, message: row.message }] });
      expect(f.paths).toEqual([]);
    }
    expect(await f.db.select().from(f.schema.settlements).where(eq(f.schema.settlements.splitParticipantId, share.id))).toEqual([]);
  } finally {
    if (oldSecret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = oldSecret;
  }
}), 30000);

dbTest('settlement stale guards retain exact errors at the app, MCP core boundary and adapter', () => fixture(async f => {
  const share = await f.makeShare();
  const { sql } = await import('drizzle-orm');
  const { mcpRelationalWrite } = await import('@/lib/mcp/relational-write-ops');
  const { runCore, CoreFailure } = await import('@/lib/mcp/run-core');
  const { recordSettlement } = await import('@/lib/ledger/splits');
  const refs = await import('@/lib/mcp/refs');
  const oldSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = 'settlement-stale-test-secret';
  try {
    const actor = { userId: f.user, accountId: f.account }, tokenId = crypto.randomUUID();
    await f.db.insert(f.schema.mcpTokens).values({ id: tokenId, userId: f.user, accountId: f.account, name: 'Stale test', tokenHash: crypto.randomUUID(), tokenHint: 'mny_test', scope: 'write', userTokenVersion: 0 });
    const principal = { actor, scope: 'write' as const, tokenId, label: 'Stale test' };
    const key = refs.deriveMcpRefKey(process.env.AUTH_SECRET);
    const rows = [{ splitParticipantId: share.id, amountPaise: 1000 }];
    unwrap(await f.call(f.split.recordSettlementSpec, { inflowTransactionId: f.credit, allocations: rows }));
    const message = "This payment's allocations changed since you opened it. Reload and review.";
    f.paths.length = 0;
    expect(await f.call(f.split.recordSettlementSpec, { inflowTransactionId: f.credit, allocations: rows, expectedAllocations: [] })).toEqual({ ok: false, code: 'CONFLICT', message });
    // MCP append intentionally has no client expected-allocations field. Test
    // that optional core guard through its real MCP Effect error boundary.
    let caught: unknown;
    try {
      await runCore(recordSettlement({ actor, source: 'mcp', tokenId, label: 'Stale test', idempotency: { key: 'stale-core-guard', requestHash: 'test-stale-guard' } }, { inflowTransactionId: f.credit, mode: 'append', allocations: { kind: 'explicit', rows }, expected: { allocations: [] } }), principal);
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CoreFailure);
    expect((caught as CoreFailure).error).toEqual({ code: 'stale', message });
    // The real adapter supplies a full relational snapshot instead. Hold the
    // actor lock until it reaches the core, change a share, then release it.
    let acquired!: (pid: number) => void, release!: () => void;
    const ready = new Promise<number>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocker = f.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'ledger-relations:' + f.user}, 0))`);
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      acquired(row.pid);
      await gate;
    });
    const pid = await ready;
    const pending = mcpRelationalWrite(principal, 'record_settlement', { inflow_ref: refs.transactionRef(key, f.user, f.credit), person: 'Kiran', allocations: [{ share_ref: refs.shareRef(key, f.user, f.account, share.id), amount: '10' }], idempotency_key: 'stale-adapter-guard' });
    try {
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i++) {
        const [row] = await f.db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as waiting`);
        waiting = row.waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      await f.db.update(f.schema.splitParticipants).set({ expectedAmountPaise: 6001 }).where(eq(f.schema.splitParticipants.id, share.id));
    } finally { release(); await blocker; }
    expect(await pending).toEqual({ applied: false, errors: [{ code: 'stale', message: 'Shares, settlements or people changed. Read them again before writing.' }] });
    expect(f.paths).toEqual([]);
  } finally {
    if (oldSecret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = oldSecret;
  }
}), 30000);
