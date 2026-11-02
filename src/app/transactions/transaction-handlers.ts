import "server-only";
import { Effect, Schema } from "effect";
import type { ActionSpec } from "@/lib/action/core";
import { CurrentUser, query, type Db } from "@/lib/action/services";
import { fromLedger, ledgerFailure } from "@/lib/action/ledger";
import { Conflict, NotFound } from "@/lib/action/errors";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { detectTransferPairs } from "@/domain/transfers/detect";
import {
  assertCounterpartyOwned,
  assertTransactionOwned,
  assertTransactionsOwned,
} from "@/lib/auth/ownership";
import { LedgerError } from "@/lib/ledger/context";
import {
  editTransactionFields,
  type EditResult,
} from "@/lib/ledger/transaction-fields";
import { setPayeeDefault } from "@/lib/ledger/payee-default";
import { setCategoryForActor } from "@/lib/transactions/category-for-actor";
import { counterpartyLabel } from "@/lib/format";
import { summarizeSplitSettlement } from "@/lib/splits/settlement-status";
import type { SplitSettlementStatus } from "@/lib/splits/settlement-status";
export interface NoteCandidate {
  id: string;
  txnDate: string;
  amountPaise: number;
  drCr: "debit" | "credit";
  rawDescription: string;
  currentNote: string | null;
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

const setTransactionCategoryInput = Schema.Struct({
  transactionId: Schema.String,
  categoryId: Schema.String,
  expectedCurrentCategoryId: Schema.optional(Schema.NullOr(Schema.String)),
});
export const setTransactionCategorySpec: ActionSpec<
  typeof setTransactionCategoryInput.Type,
  typeof setTransactionCategoryInput.Encoded,
  void,
  CurrentUser | Db
> = {
  input: setTransactionCategoryInput,
  revalidate: ["/transactions", "/"],
  handler: Effect.fn("setTransactionCategory")(function* (input) {
    const user = yield* CurrentUser;
    // The shared write (also used by the assistant's tag apply/undo). Only the
    // declared fields are passed, so a client can't force `isTransfer`.
    yield* fromLedger(() =>
      setCategoryForActor(
        { userId: user.id },
        {
          transactionId: input.transactionId,
          categoryId: input.categoryId,
          ...(input.expectedCurrentCategoryId !== undefined
            ? { expectedCurrentCategoryId: input.expectedCurrentCategoryId }
            : {}),
        },
      ),
    );
  }),
};

const applyCategoryToCounterpartyInput = Schema.Struct({
  transactionId: Schema.String,
});
export const applyCategoryToCounterpartySpec: ActionSpec<
  typeof applyCategoryToCounterpartyInput.Type,
  typeof applyCategoryToCounterpartyInput.Encoded,
  { revalidate: boolean; value: { updated: number; ids: string[] } },
  CurrentUser | Db,
  { updated: number; ids: string[] }
> = {
  input: applyCategoryToCounterpartyInput,
  revalidate: ["/transactions", "/"],
  revalidateWhen: (r) => r.revalidate,
  toData: (r) => r.value,
  handler: Effect.fn("applyCategoryToCounterparty")(function* (input) {
    const user = yield* CurrentUser;
    const { accountId } = yield* fromLedger(() =>
      assertTransactionOwned(user.id, input.transactionId),
    );

    const [txn] = yield* query((db) =>
      db
        .select({
          counterpartyId: schema.transactions.counterpartyId,
          categoryId: schema.transactions.categoryId,
        })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, input.transactionId))
        .limit(1),
    );
    if (!txn || !txn.counterpartyId || !txn.categoryId)
      return { revalidate: false, value: { updated: 0, ids: [] as string[] } };

    const { counterpartyId, categoryId } = txn;
    const actor = { userId: user.id, accountId };
    yield* fromLedger(() => assertCounterpartyOwned(user.id, counterpartyId));
    const [payee] = yield* query((db) =>
      db
        .select({ defaultCategoryId: schema.counterparties.defaultCategoryId })
        .from(schema.counterparties)
        .where(
          and(
            eq(schema.counterparties.id, counterpartyId),
            eq(schema.counterparties.userId, user.id),
          ),
        ),
    );
    const defaultResult = yield* fromLedger(() =>
      setPayeeDefault(
        { actor, source: "app" },
        {
          counterpartyId: counterpartyId,
          categoryId: categoryId,
          guard: { currentDefaultCategoryId: payee?.defaultCategoryId ?? null },
        },
      ),
    );
    if (defaultResult.confirm)
      return yield* new Conflict({
        message: "The payee default changed. Try again.",
      });
    const candidates = yield* query((db) =>
      db
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.counterpartyId, counterpartyId),
            eq(schema.transactions.accountId, accountId),
            isNull(schema.transactions.categoryId),
          ),
        ),
    );
    const result = yield* fromLedger(() =>
      editTransactionFields(
        { actor, source: "app" },
        {
          kind: "transaction_fields",
          partial: true,
          edits: candidates.map((row) => ({
            transactionId: row.id,
            set: { categoryId: categoryId },
            guard: { categoryId: null },
          })),
        },
      ),
    );
    const updated = result.rows.map((row) => ({ id: row.transactionId }));

    return {
      revalidate: true,
      value: { updated: updated.length, ids: updated.map((r) => r.id) },
    };
  }),
};

const setTransactionTransferInput = Schema.Struct({
  transactionId: Schema.String,
  isTransfer: Schema.Boolean,
});
export const setTransactionTransferSpec: ActionSpec<
  typeof setTransactionTransferInput.Type,
  typeof setTransactionTransferInput.Encoded,
  void,
  CurrentUser | Db
> = {
  input: setTransactionTransferInput,
  revalidate: ["/transactions", "/review", "/"],
  handler: Effect.fn("setTransactionTransfer")(function* (input) {
    const user = yield* CurrentUser;
    const { accountId } = yield* fromLedger(() =>
      assertTransactionOwned(user.id, input.transactionId),
    );
    yield* assertEdit(
      yield* fromLedger(() =>
        editTransactionFields(
          { actor: { userId: user.id, accountId }, source: "app" },
          {
            kind: "transaction_fields",
            edits: [
              {
                transactionId: input.transactionId,
                set: { isTransfer: input.isTransfer },
              },
            ],
          },
        ),
      ),
    );
  }),
};

const setTransactionNeedsReviewInput = Schema.Struct({
  transactionId: Schema.String,
  needsReview: Schema.Boolean,
});
export const setTransactionNeedsReviewSpec: ActionSpec<
  typeof setTransactionNeedsReviewInput.Type,
  typeof setTransactionNeedsReviewInput.Encoded,
  void,
  CurrentUser | Db
> = {
  input: setTransactionNeedsReviewInput,
  revalidate: ["/transactions", "/review", "/"],
  handler: Effect.fn("setTransactionNeedsReview")(function* (input) {
    const user = yield* CurrentUser;
    const { accountId } = yield* fromLedger(() =>
      assertTransactionOwned(user.id, input.transactionId),
    );
    yield* assertEdit(
      yield* fromLedger(() =>
        editTransactionFields(
          { actor: { userId: user.id, accountId }, source: "app" },
          {
            kind: "transaction_fields",
            edits: [
              {
                transactionId: input.transactionId,
                set: { needsReview: input.needsReview },
              },
            ],
          },
        ),
      ),
    );
  }),
};

const setTransactionNoteInput = Schema.Struct({
  transactionId: Schema.String,
  note: Schema.String,
  expectedCurrentNote: Schema.optional(Schema.NullOr(Schema.String)),
});
export const setTransactionNoteSpec: ActionSpec<
  typeof setTransactionNoteInput.Type,
  typeof setTransactionNoteInput.Encoded,
  void,
  CurrentUser | Db
> = {
  input: setTransactionNoteInput,
  revalidate: ["/transactions", "/"],
  handler: Effect.fn("setTransactionNote")(function* (input) {
    const user = yield* CurrentUser;
    const { accountId } = yield* fromLedger(() =>
      assertTransactionOwned(user.id, input.transactionId),
    );
    const result = yield* fromLedger(() =>
      editTransactionFields(
        { actor: { userId: user.id, accountId }, source: "app" },
        {
          kind: "transaction_fields",
          edits: [
            {
              transactionId: input.transactionId,
              set: { note: input.note },
              ...(input.expectedCurrentNote !== undefined
                ? { guard: { note: input.expectedCurrentNote } }
                : {}),
            },
          ],
        },
      ),
    );
    if (result.errors?.some((e) => e.code === "stale"))
      return yield* new Conflict({
        message:
          "The note changed since this card was made. Ask again to get a fresh card.",
      });
    yield* assertEdit(result);
  }),
};

const getNoteCandidatesInput = Schema.Struct({ transactionId: Schema.String });
export const getNoteCandidatesSpec: ActionSpec<
  typeof getNoteCandidatesInput.Type,
  typeof getNoteCandidatesInput.Encoded,
  NoteCandidate[],
  CurrentUser | Db
> = {
  input: getNoteCandidatesInput,
  handler: Effect.fn("getNoteCandidates")(function* (input) {
    const user = yield* CurrentUser;
    const { accountId } = yield* fromLedger(() =>
      assertTransactionOwned(user.id, input.transactionId),
    );

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

const applyNoteToTransactionsInput = Schema.Struct({
  transactionIds: Schema.Array(Schema.String),
  note: Schema.String,
});
export const applyNoteToTransactionsSpec: ActionSpec<
  typeof applyNoteToTransactionsInput.Type,
  typeof applyNoteToTransactionsInput.Encoded,
  { revalidate: boolean; value: { updated: number } },
  CurrentUser | Db,
  { updated: number }
> = {
  input: applyNoteToTransactionsInput,
  revalidate: ["/transactions", "/"],
  revalidateWhen: (r) => r.revalidate,
  toData: (r) => r.value,
  handler: Effect.fn("applyNoteToTransactions")(function* (input) {
    const user = yield* CurrentUser;
    const cleaned = input.note.trim();
    if (input.transactionIds.length === 0)
      return { revalidate: false, value: { updated: 0 } };
    yield* fromLedger(() =>
      assertTransactionsOwned(user.id, [...input.transactionIds]),
    );
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* fromLedger(() =>
      editTransactionFields(
        { actor: { userId: user.id, accountId: account.id }, source: "app" },
        {
          kind: "transaction_fields",
          edits: [...new Set(input.transactionIds)].map((transactionId) => ({
            transactionId,
            set: { note: cleaned },
          })),
        },
      ),
    );
    yield* assertEdit(result);
    const updated = result.rows;

    return { revalidate: true, value: { updated: updated.length } };
  }),
};

const autoDetectTransfersInput = Schema.Void;
export const autoDetectTransfersSpec: ActionSpec<
  typeof autoDetectTransfersInput.Type,
  typeof autoDetectTransfersInput.Encoded,
  { pairs: number },
  CurrentUser | Db
> = {
  input: autoDetectTransfersInput,
  // As before: only /transactions when nothing was found.
  revalidate: (r) => (r.pairs === 0 ? ["/transactions"] : ["/transactions", "/", "/timeline"]),
  handler: Effect.fn("autoDetectTransfers")(function* () {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const rows = yield* query((db) =>
      db
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
        .where(eq(schema.transactions.accountId, account.id)),
    );

    const pairs = detectTransferPairs(rows);
    if (pairs.length === 0) {
      return { pairs: 0 };
    }
    const ids = pairs.flatMap((p) => [p.debitId, p.creditId]);
    yield* assertEdit(
      yield* fromLedger(() =>
        editTransactionFields(
          { actor: { userId: user.id, accountId: account.id }, source: "app" },
          {
            kind: "transaction_fields",
            edits: [...new Set(ids)].map((transactionId) => ({
              transactionId,
              set: { isTransfer: true },
            })),
          },
        ),
      ),
    );

    return { pairs: pairs.length };
  }),
};

const getLinkedTransactionPreviewInput = Schema.Struct({
  transactionId: Schema.String,
});
export const getLinkedTransactionPreviewSpec: ActionSpec<
  typeof getLinkedTransactionPreviewInput.Type,
  typeof getLinkedTransactionPreviewInput.Encoded,
  LinkedTransactionPreview,
  CurrentUser | Db
> = {
  input: getLinkedTransactionPreviewInput,
  handler: Effect.fn("getLinkedTransactionPreview")(function* (input) {
    const user = yield* CurrentUser;
    yield* fromLedger(() =>
      assertTransactionOwned(user.id, input.transactionId),
    );

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
                .where(
                  inArray(
                    schema.settlements.splitParticipantId,
                    participantIds,
                  ),
                ),
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

const assertEdit = Effect.fn("assertEdit")(function* (result: EditResult) {
  const error = result.errors?.[0];
  if (error)
    return yield* ledgerFailure(
      new LedgerError({ code: error.code, message: error.message }),
    );
});
