"use server";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { detectTransferPairs } from "@/domain/transfers/detect";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import {
  assertCategoryOwned,
  assertCounterpartyOwned,
  assertTransactionOwned,
  assertTransactionsOwned,
} from "@/lib/auth/ownership";
import { counterpartyLabel } from "@/lib/format";
import { summarizeSplitSettlement } from "@/lib/splits/settlement-status";
import type { SplitSettlementStatus } from "@/lib/splits/settlement-status";

export async function setTransactionCategory(input: {
  transactionId: string;
  categoryId: string;
}) {
  const user = await requireCurrentUserAction();
  const { accountId } = await assertTransactionOwned(
    user.id,
    input.transactionId,
  );
  const newCategoryId = input.categoryId === "" ? null : input.categoryId;
  if (newCategoryId) {
    await assertCategoryOwned(user.id, newCategoryId);
  }
  const isTransfer = newCategoryId
    ? await categoryIsTransfer(newCategoryId, user.id)
    : false;

  await db
    .update(schema.transactions)
    .set({ categoryId: newCategoryId, isTransfer })
    .where(
      and(
        eq(schema.transactions.id, input.transactionId),
        eq(schema.transactions.accountId, accountId),
      ),
    );

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
  if (!txn || !txn.counterpartyId || !txn.categoryId) return { updated: 0 };

  const isTransfer = await categoryIsTransfer(txn.categoryId, user.id);

  await assertCounterpartyOwned(user.id, txn.counterpartyId);

  await db
    .update(schema.counterparties)
    .set({ defaultCategoryId: txn.categoryId })
    .where(
      and(
        eq(schema.counterparties.id, txn.counterpartyId),
        eq(schema.counterparties.userId, user.id),
      ),
    );

  const updated = await db
    .update(schema.transactions)
    .set({ categoryId: txn.categoryId, isTransfer })
    .where(
      and(
        eq(schema.transactions.counterpartyId, txn.counterpartyId),
        eq(schema.transactions.accountId, accountId),
        isNull(schema.transactions.categoryId),
      ),
    )
    .returning({ id: schema.transactions.id });

  revalidatePath("/transactions");
  revalidatePath("/");
  return { updated: updated.length };
}

async function categoryIsTransfer(
  categoryId: string,
  userId: string,
): Promise<boolean> {
  const [cat] = await db
    .select({ kind: schema.categories.kind })
    .from(schema.categories)
    .where(
      and(
        eq(schema.categories.id, categoryId),
        eq(schema.categories.userId, userId),
      ),
    )
    .limit(1);
  return cat?.kind === "transfer" || cat?.kind === "investment";
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
  await db
    .update(schema.transactions)
    .set({ isTransfer: input.isTransfer })
    .where(
      and(
        eq(schema.transactions.id, input.transactionId),
        eq(schema.transactions.accountId, accountId),
      ),
    );
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
  await db
    .update(schema.transactions)
    .set({ needsReview: input.needsReview })
    .where(
      and(
        eq(schema.transactions.id, input.transactionId),
        eq(schema.transactions.accountId, accountId),
      ),
    );
  revalidatePath("/transactions");
  revalidatePath("/review");
  revalidatePath("/");
}

export async function setTransactionNote(input: {
  transactionId: string;
  note: string;
}) {
  const user = await requireCurrentUserAction();
  const { accountId } = await assertTransactionOwned(
    user.id,
    input.transactionId,
  );
  const cleaned = input.note.trim();
  await db
    .update(schema.transactions)
    .set({ note: cleaned === "" ? null : cleaned })
    .where(
      and(
        eq(schema.transactions.id, input.transactionId),
        eq(schema.transactions.accountId, accountId),
      ),
    );
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
  const updated = await db
    .update(schema.transactions)
    .set({ note: cleaned === "" ? null : cleaned })
    .where(inArray(schema.transactions.id, input.transactionIds))
    .returning({ id: schema.transactions.id });
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
  await db
    .update(schema.transactions)
    .set({ isTransfer: true })
    .where(inArray(schema.transactions.id, ids));
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
