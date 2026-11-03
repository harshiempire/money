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
      expect(f.paths).toEqual(["/transactions", "/reimbursements", "/"]);
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
      ).toEqual({ ok: true, data: undefined });
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
      ).toEqual({ ok: true, data: undefined });
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
      ).toEqual({ ok: true, data: undefined });
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
      // Same as main: nothing found → only /transactions.
      expect(f.paths).toEqual(["/transactions"]);
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
      expect(f.paths).toEqual(["/import", "/transactions"]);
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
  expect(f.paths).toEqual(["/transactions", "/reimbursements", "/people", "/spend", "/", "/connections"]);
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
  expect(f.paths).toEqual(["/transactions", "/"]);
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
  expect(f.paths).toEqual(["/transactions", "/"]);
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
