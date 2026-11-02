"use server";

import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { defineAction } from "@/lib/action/define-action";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import { assertTransactionOwned } from "@/lib/auth/ownership";
import { counterpartyLabel } from "@/lib/format";
import { summarizeSplitSettlement } from "@/lib/splits/settlement-status";
import type { SplitSettlementStatus } from "@/lib/splits/settlement-status";
import {
  applyCategoryToCounterpartySpec,
  applyNoteToTransactionsSpec,
  autoDetectTransfersSpec,
  setTransactionCategorySpec,
  setTransactionNeedsReviewSpec,
  setTransactionNoteSpec,
  setTransactionTransferSpec,
} from "./transaction-handlers";

// Edits: logic lives in ./transaction-handlers.ts.
export const setTransactionCategory = defineAction("setTransactionCategory", setTransactionCategorySpec);
export const applyCategoryToCounterparty = defineAction("applyCategoryToCounterparty", applyCategoryToCounterpartySpec);
export const setTransactionTransfer = defineAction("setTransactionTransfer", setTransactionTransferSpec);
export const setTransactionNeedsReview = defineAction("setTransactionNeedsReview", setTransactionNeedsReviewSpec);
export const setTransactionNote = defineAction("setTransactionNote", setTransactionNoteSpec);
export const applyNoteToTransactions = defineAction("applyNoteToTransactions", applyNoteToTransactionsSpec);
export const autoDetectTransfers = defineAction("autoDetectTransfers", autoDetectTransfersSpec);

// Reads (not migrated yet).

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
