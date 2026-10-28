"use server";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { detectTransferPairs } from "@/domain/transfers/detect";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import {
  assertCounterpartyOwned,
  assertTransactionOwned,
  assertTransactionsOwned,
} from "@/lib/auth/ownership";
import { setCategoryForActor } from "@/lib/transactions/category-for-actor";
import { editTransactionFields, type EditResult } from "@/lib/ledger/transaction-fields";
import { setPayeeDefault } from "@/lib/ledger/payee-default";
import { counterpartyLabel } from "@/lib/format";
import { summarizeSplitSettlement } from "@/lib/splits/settlement-status";
import type { SplitSettlementStatus } from "@/lib/splits/settlement-status";

export async function setTransactionCategory(input: {
  transactionId: string;
  categoryId: string;
  /** The category the caller last saw (null = none); a changed one isn't overwritten. */
  expectedCurrentCategoryId?: string | null;
}) {
  const user = await requireCurrentUserAction();
  await setCategoryForActor({ userId: user.id }, input);
  revalidatePath("/transactions");
  revalidatePath("/");
}

export async function applyCategoryToCounterparty(input: {
  transactionId: string;
}) {
  const user = await requireCurrentUserAction();
  const { accountId } = await assertTransactionOwned(
    user.id,
    input.transactionId,
  );

  const [txn] = await db
    .select({
      counterpartyId: schema.transactions.counterpartyId,
      categoryId: schema.transactions.categoryId,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, input.transactionId))
    .limit(1);
  if (!txn || !txn.counterpartyId || !txn.categoryId) return { updated: 0, ids: [] as string[] };

  const actor = { userId: user.id, accountId };
  await assertCounterpartyOwned(user.id, txn.counterpartyId);
  const [payee] = await db.select({ defaultCategoryId: schema.counterparties.defaultCategoryId })
    .from(schema.counterparties).where(and(eq(schema.counterparties.id, txn.counterpartyId), eq(schema.counterparties.userId, user.id)));
  const defaultResult = await setPayeeDefault({ actor, source: "app" }, {
    counterpartyId: txn.counterpartyId, categoryId: txn.categoryId,
    guard: { currentDefaultCategoryId: payee?.defaultCategoryId ?? null },
  });
  if (defaultResult.confirm) throw new Error("The payee default changed. Try again.");
  const candidates = await db.select({ id: schema.transactions.id }).from(schema.transactions).where(and(
    eq(schema.transactions.counterpartyId, txn.counterpartyId), eq(schema.transactions.accountId, accountId), isNull(schema.transactions.categoryId)));
  const result = await editTransactionFields({ actor, source: "app" }, {
    kind: "transaction_fields", partial: true,
    edits: candidates.map((row) => ({ transactionId: row.id, set: { categoryId: txn.categoryId }, guard: { categoryId: null } })),
  });
  const updated = result.rows.map((row) => ({ id: row.transactionId }));

  revalidatePath("/transactions");
  revalidatePath("/");
  return { updated: updated.length, ids: updated.map((r) => r.id) };
}

export async function setTransactionTransfer(input: {
  transactionId: string;
  isTransfer: boolean;
}) {
  const user = await requireCurrentUserAction();
  const { accountId } = await assertTransactionOwned(
    user.id,
    input.transactionId,
  );
  assertEdit(await editTransactionFields({ actor: { userId: user.id, accountId }, source: "app" }, {
    kind: "transaction_fields", edits: [{ transactionId: input.transactionId, set: { isTransfer: input.isTransfer } }],
  }));
  revalidatePath("/transactions");
  revalidatePath("/review");
  revalidatePath("/");
}

export async function setTransactionNeedsReview(input: {
  transactionId: string;
  needsReview: boolean;
}) {
  const user = await requireCurrentUserAction();
  const { accountId } = await assertTransactionOwned(
    user.id,
    input.transactionId,
  );
  assertEdit(await editTransactionFields({ actor: { userId: user.id, accountId }, source: "app" }, {
    kind: "transaction_fields", edits: [{ transactionId: input.transactionId, set: { needsReview: input.needsReview } }],
  }));
  revalidatePath("/transactions");
  revalidatePath("/review");
  revalidatePath("/");
}

export async function setTransactionNote(input: {
  transactionId: string;
  note: string;
  /**
   * The note the caller last saw. When given, a note that has changed since
   * is not overwritten — the assistant's cards can sit open for a while.
   */
  expectedCurrentNote?: string | null;
}) {
  const user = await requireCurrentUserAction();
  const { accountId } = await assertTransactionOwned(
    user.id,
    input.transactionId,
  );
  const result = await editTransactionFields({ actor: { userId: user.id, accountId }, source: "app" }, {
    kind: "transaction_fields", edits: [{ transactionId: input.transactionId, set: { note: input.note },
      ...(input.expectedCurrentNote !== undefined ? { guard: { note: input.expectedCurrentNote } } : {}),
    }],
  });
  if (result.errors?.some((e) => e.code === "stale")) throw new Error("The note changed since this card was made. Ask again to get a fresh card.");
  assertEdit(result);
  revalidatePath("/transactions");
  revalidatePath("/");
}

export interface NoteCandidate {
  id: string;
  txnDate: string;
  amountPaise: number;
  drCr: "debit" | "credit";
  rawDescription: string;
  currentNote: string | null;
}

export async function getNoteCandidates(input: {
  transactionId: string;
}): Promise<NoteCandidate[]> {
  const user = await requireCurrentUserAction();
  const { accountId } = await assertTransactionOwned(
    user.id,
    input.transactionId,
  );

  const [self] = await db
    .select({ counterpartyId: schema.transactions.counterpartyId })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, input.transactionId))
    .limit(1);
  if (!self || !self.counterpartyId) return [];

  const rows = await db
    .select({
      id: schema.transactions.id,
      txnDate: schema.transactions.txnDate,
      amountPaise: schema.transactions.amountPaise,
      drCr: schema.transactions.drCr,
      rawDescription: schema.transactions.rawDescription,
      currentNote: schema.transactions.note,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.counterpartyId, self.counterpartyId),
        eq(schema.transactions.accountId, accountId),
      ),
    )
    .orderBy(desc(schema.transactions.txnDate));

  return rows
    .filter((r) => r.id !== input.transactionId)
    .map((r) => ({
      id: r.id,
      txnDate: r.txnDate,
      amountPaise: Number(r.amountPaise),
      drCr: r.drCr,
      rawDescription: r.rawDescription,
      currentNote: r.currentNote,
    }));
}

export async function applyNoteToTransactions(input: {
  transactionIds: string[];
  note: string;
}): Promise<{ updated: number }> {
  const user = await requireCurrentUserAction();
  const cleaned = input.note.trim();
  if (input.transactionIds.length === 0) return { updated: 0 };
  await assertTransactionsOwned(user.id, input.transactionIds);
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const result = await editTransactionFields({ actor: { userId: user.id, accountId: account.id }, source: "app" }, {
    kind: "transaction_fields", edits: [...new Set(input.transactionIds)].map((transactionId) => ({ transactionId, set: { note: cleaned } })),
  });
  assertEdit(result);
  const updated = result.rows;
  revalidatePath("/transactions");
  revalidatePath("/");
  return { updated: updated.length };
}

export async function autoDetectTransfers(): Promise<{ pairs: number }> {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const rows = await db
    .select({
      id: schema.transactions.id,
      txnDate: schema.transactions.txnDate,
      amountPaise: schema.transactions.amountPaise,
      drCr: schema.transactions.drCr,
      channel: schema.transactions.channel,
      counterpartyId: schema.transactions.counterpartyId,
      isTransfer: schema.transactions.isTransfer,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.accountId, account.id));

  const pairs = detectTransferPairs(rows);
  if (pairs.length === 0) {
    revalidatePath("/transactions");
    return { pairs: 0 };
  }
  const ids = pairs.flatMap((p) => [p.debitId, p.creditId]);
  assertEdit(await editTransactionFields({ actor: { userId: user.id, accountId: account.id }, source: "app" }, {
    kind: "transaction_fields", edits: [...new Set(ids)].map((transactionId) => ({ transactionId, set: { isTransfer: true } })),
  }));
  revalidatePath("/transactions");
  revalidatePath("/");
  revalidatePath("/timeline");
  return { pairs: pairs.length };
}

export type LinkedTransactionPreview = {
  id: string;
  txnDate: string;
  amountPaise: number;
  drCr: "debit" | "credit";
  channel: string;
  counterpartyLabel: string;
  parsedPurpose: string | null;
  note: string | null;
  split: {
    yourSharePaise: number;
    totalPaise: number;
    status: SplitSettlementStatus;
    expectedReimbursePaise: number;
    settledReimbursePaise: number;
    outstandingReimbursePaise: number;
    participants: Array<{
      personName: string;
      expectedAmountPaise: number;
      settledAmountPaise: number;
      outstandingAmountPaise: number;
    }>;
  } | null;
};

export async function getLinkedTransactionPreview(input: {
  transactionId: string;
}): Promise<LinkedTransactionPreview> {
  const user = await requireCurrentUserAction();
  await assertTransactionOwned(user.id, input.transactionId);

  const [txn] = await db
    .select({
      id: schema.transactions.id,
      txnDate: schema.transactions.txnDate,
      amountPaise: schema.transactions.amountPaise,
      drCr: schema.transactions.drCr,
      channel: schema.transactions.channel,
      rawDescription: schema.transactions.rawDescription,
      parsedPurpose: schema.transactions.parsedPurpose,
      note: schema.transactions.note,
      counterpartyDisplayName: schema.counterparties.displayName,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.counterparties,
      eq(schema.transactions.counterpartyId, schema.counterparties.id),
    )
    .where(eq(schema.transactions.id, input.transactionId))
    .limit(1);

  if (!txn) {
    throw new Error("Transaction not found");
  }

  const [splitRow] = await db
    .select()
    .from(schema.splits)
    .where(eq(schema.splits.transactionId, input.transactionId))
    .limit(1);

  let split: LinkedTransactionPreview["split"] = null;

  if (splitRow) {
    const participants = await db
      .select()
      .from(schema.splitParticipants)
      .where(eq(schema.splitParticipants.splitId, splitRow.id));

    const participantIds = participants.map((p) => p.id);
    const settlements =
      participantIds.length > 0
        ? await db
            .select({
              splitParticipantId: schema.settlements.splitParticipantId,
              amountPaise: schema.settlements.amountPaise,
            })
            .from(schema.settlements)
            .where(
              inArray(schema.settlements.splitParticipantId, participantIds),
            )
        : [];

    const settledByParticipant = new Map<string, number>();
    for (const s of settlements) {
      if (!s.splitParticipantId) continue;
      settledByParticipant.set(
        s.splitParticipantId,
        (settledByParticipant.get(s.splitParticipantId) ?? 0) +
          Number(s.amountPaise),
      );
    }

    const participantRows = participants.map((p) => {
      const expected = Number(p.expectedAmountPaise);
      const settled = settledByParticipant.get(p.id) ?? 0;
      return {
        personName: p.personName,
        expectedAmountPaise: expected,
        settledAmountPaise: settled,
        outstandingAmountPaise: Math.max(0, expected - settled),
      };
    });

    const summary = summarizeSplitSettlement(
      participantRows.map((p) => ({
        expectedAmountPaise: p.expectedAmountPaise,
        settledAmountPaise: p.settledAmountPaise,
      })),
    );

    split = {
      yourSharePaise: Number(splitRow.yourSharePaise),
      totalPaise: Number(splitRow.totalPaise),
      status: summary.status,
      expectedReimbursePaise: summary.expectedReimbursePaise,
      settledReimbursePaise: summary.settledReimbursePaise,
      outstandingReimbursePaise: summary.outstandingReimbursePaise,
      participants: participantRows,
    };
  }

  return {
    id: txn.id,
    txnDate: txn.txnDate,
    amountPaise: txn.amountPaise,
    drCr: txn.drCr,
    channel: txn.channel,
    counterpartyLabel:
      txn.counterpartyDisplayName ??
      counterpartyLabel(txn.rawDescription),
    parsedPurpose: txn.parsedPurpose,
    note: txn.note,
    split,
  };
}

function assertEdit(result: EditResult): void {
  if (result.errors?.length) throw new Error(result.errors[0].message);
}
