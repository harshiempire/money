import "server-only";
import { desc, eq, inArray, and } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { schema } from "@/db";
import type { ActionSpec } from "@/lib/action/core";
import { NotFound } from "@/lib/action/errors";
import { owns } from "@/lib/action/ownership";
import { query, type CurrentUser, type Db } from "@/lib/action/services";
import { counterpartyLabel } from "@/lib/format";
import { summarizeSplitSettlement } from "@/lib/splits/settlement-status";
import type { LinkedTransactionPreview, NoteCandidate } from "@/lib/transactions/types";

/**
 * Read handlers behind ./actions.ts (the note dialog's sibling list and the
 * linked-transaction preview). Translated one statement at a time from the
 * pre-Effect implementations; reads never revalidate.
 */

const TransactionRef = Schema.Struct({ transactionId: Schema.String });
type Ref = typeof TransactionRef;

// ─── getNoteCandidates ───────────────────────────────────────────────────────

export const getNoteCandidatesSpec: ActionSpec<Ref["Type"], Ref["Encoded"], NoteCandidate[], CurrentUser | Db> = {
  input: TransactionRef,
  handler: Effect.fn("getNoteCandidates")(function* (input) {
    const { accountId } = yield* owns.transaction(input.transactionId);

    const [self] = yield* query((db) =>
      db
        .select({ counterpartyId: schema.transactions.counterpartyId })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, input.transactionId))
        .limit(1),
    );
    if (!self || !self.counterpartyId) return [];
    const counterpartyId = self.counterpartyId;

    const rows = yield* query((db) =>
      db
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
            eq(schema.transactions.counterpartyId, counterpartyId),
            eq(schema.transactions.accountId, accountId),
          ),
        )
        .orderBy(desc(schema.transactions.txnDate)),
    );

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
  }),
};

// ─── getLinkedTransactionPreview ─────────────────────────────────────────────

export const getLinkedTransactionPreviewSpec: ActionSpec<Ref["Type"], Ref["Encoded"], LinkedTransactionPreview, CurrentUser | Db> = {
  input: TransactionRef,
  handler: Effect.fn("getLinkedTransactionPreview")(function* (input) {
    yield* owns.transaction(input.transactionId);

    const [txn] = yield* query((db) =>
      db
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
        .limit(1),
    );

    if (!txn) {
      return yield* new NotFound({ message: "Transaction not found" });
    }

    const [splitRow] = yield* query((db) =>
      db
        .select()
        .from(schema.splits)
        .where(eq(schema.splits.transactionId, input.transactionId))
        .limit(1),
    );

    let split: LinkedTransactionPreview["split"] = null;

    if (splitRow) {
      const participants = yield* query((db) =>
        db
          .select()
          .from(schema.splitParticipants)
          .where(eq(schema.splitParticipants.splitId, splitRow.id)),
      );

      const participantIds = participants.map((p) => p.id);
      const settlements =
        participantIds.length > 0
          ? yield* query((db) =>
              db
                .select({
                  splitParticipantId: schema.settlements.splitParticipantId,
                  amountPaise: schema.settlements.amountPaise,
                })
                .from(schema.settlements)
                .where(inArray(schema.settlements.splitParticipantId, participantIds)),
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
        txn.counterpartyDisplayName ?? counterpartyLabel(txn.rawDescription),
      parsedPurpose: txn.parsedPurpose,
      note: txn.note,
      split,
    };
  }),
};
