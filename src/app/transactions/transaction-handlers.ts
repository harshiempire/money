import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { detectTransferPairs } from "@/domain/transfers/detect";
import type { ActionSpec } from "@/lib/action/core";
import { Conflict, Forbidden } from "@/lib/action/errors";
import { owns } from "@/lib/action/ownership";
import { ForbiddenError } from "@/lib/auth/forbidden";
import {
  StaleValueError,
  categoryIsTransfer,
  setCategoryForActor,
} from "@/lib/transactions/category-for-actor";
import { CurrentUser, query, type Db } from "@/lib/action/services";

/**
 * Per-transaction edit handlers behind ./actions.ts: category, "apply to
 * all", transfer flag, review flag, notes, auto-detect transfers.
 *
 * Translated one statement at a time from the pre-Effect implementations:
 * same queries, order and early returns. Revalidation runs on every success,
 * including early-return paths that used to skip it (e.g. "apply to all"
 * with nothing to apply; auto-detect with no pairs now also revalidates
 * "/" and "/timeline").
 *
 * Integration check: scripts/test-transaction-actions.ts.
 */

type Spec<I, IEncoded, A = void> = ActionSpec<I, IEncoded, A, CurrentUser | Db>;

const TransactionRef = Schema.Struct({ transactionId: Schema.String });

const isTransferCategory = (categoryId: string, userId: string) =>
  Effect.promise(() => categoryIsTransfer(categoryId, userId));

// ─── setTransactionCategory ──────────────────────────────────────────────────

const SetCategoryInput = Schema.Struct({
  transactionId: Schema.String,
  // "" clears the category (the picker's "—" option).
  categoryId: Schema.String,
  /** The category the caller last saw (null = none); a changed one isn't overwritten. */
  expectedCurrentCategoryId: Schema.optional(Schema.NullOr(Schema.String)),
});

export const setTransactionCategorySpec: Spec<
  typeof SetCategoryInput.Type,
  typeof SetCategoryInput.Encoded
> = {
  input: SetCategoryInput,
  revalidate: ["/transactions", "/"],
  handler: Effect.fn("setTransactionCategory")(function* (input) {
    const user = yield* CurrentUser;
    // The shared write (also used by the assistant): ownership, the
    // stale-card check, category ownership, transfer flag, update. Only the
    // declared fields are passed — a client can't force `isTransfer`.
    yield* Effect.tryPromise({
      try: () =>
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
      catch: (err) => err,
    }).pipe(
      Effect.catch((err): Effect.Effect<never, Forbidden | Conflict> =>
        err instanceof ForbiddenError
          ? Effect.fail(new Forbidden())
          : err instanceof StaleValueError
            ? Effect.fail(new Conflict({ message: err.message }))
            : Effect.die(err),
      ),
    );
  }),
};

// ─── applyCategoryToCounterparty ─────────────────────────────────────────────

export const applyCategoryToCounterpartySpec: Spec<
  typeof TransactionRef.Type,
  typeof TransactionRef.Encoded,
  { updated: number; ids: string[] }
> = {
  input: TransactionRef,
  revalidate: ["/transactions", "/"],
  handler: Effect.fn("applyCategoryToCounterparty")(function* (input) {
    const user = yield* CurrentUser;
    const { accountId } = yield* owns.transaction(input.transactionId);

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
    if (!txn || !txn.counterpartyId || !txn.categoryId) return { updated: 0, ids: [] };
    const counterpartyId = txn.counterpartyId;
    const categoryId = txn.categoryId;

    const isTransfer = yield* isTransferCategory(categoryId, user.id);

    yield* owns.counterparty(counterpartyId);

    yield* query((db) =>
      db
        .update(schema.counterparties)
        .set({ defaultCategoryId: categoryId })
        .where(
          and(
            eq(schema.counterparties.id, counterpartyId),
            eq(schema.counterparties.userId, user.id),
          ),
        ),
    );

    const updated = yield* query((db) =>
      db
        .update(schema.transactions)
        .set({ categoryId, isTransfer })
        .where(
          and(
            eq(schema.transactions.counterpartyId, counterpartyId),
            eq(schema.transactions.accountId, accountId),
            isNull(schema.transactions.categoryId),
          ),
        )
        .returning({ id: schema.transactions.id }),
    );

    return { updated: updated.length, ids: updated.map((r) => r.id) };
  }),
};

// ─── setTransactionTransfer / setTransactionNeedsReview ──────────────────────

const SetTransferInput = Schema.Struct({
  transactionId: Schema.String,
  isTransfer: Schema.Boolean,
});

export const setTransactionTransferSpec: Spec<
  typeof SetTransferInput.Type,
  typeof SetTransferInput.Encoded
> = {
  input: SetTransferInput,
  revalidate: ["/transactions", "/review", "/"],
  handler: Effect.fn("setTransactionTransfer")(function* (input) {
    const { accountId } = yield* owns.transaction(input.transactionId);
    yield* query((db) =>
      db
        .update(schema.transactions)
        .set({ isTransfer: input.isTransfer })
        .where(
          and(
            eq(schema.transactions.id, input.transactionId),
            eq(schema.transactions.accountId, accountId),
          ),
        ),
    );
  }),
};

const SetNeedsReviewInput = Schema.Struct({
  transactionId: Schema.String,
  needsReview: Schema.Boolean,
});

export const setTransactionNeedsReviewSpec: Spec<
  typeof SetNeedsReviewInput.Type,
  typeof SetNeedsReviewInput.Encoded
> = {
  input: SetNeedsReviewInput,
  revalidate: ["/transactions", "/review", "/"],
  handler: Effect.fn("setTransactionNeedsReview")(function* (input) {
    const { accountId } = yield* owns.transaction(input.transactionId);
    yield* query((db) =>
      db
        .update(schema.transactions)
        .set({ needsReview: input.needsReview })
        .where(
          and(
            eq(schema.transactions.id, input.transactionId),
            eq(schema.transactions.accountId, accountId),
          ),
        ),
    );
  }),
};

// ─── setTransactionNote / applyNoteToTransactions ────────────────────────────

const SetNoteInput = Schema.Struct({
  transactionId: Schema.String,
  note: Schema.String,
  /**
   * The note the caller last saw. When given, a note that has changed since
   * is not overwritten — the assistant's cards can sit open for a while.
   */
  expectedCurrentNote: Schema.optional(Schema.NullOr(Schema.String)),
});

export const setTransactionNoteSpec: Spec<
  typeof SetNoteInput.Type,
  typeof SetNoteInput.Encoded
> = {
  input: SetNoteInput,
  revalidate: ["/transactions", "/"],
  handler: Effect.fn("setTransactionNote")(function* (input) {
    const { accountId } = yield* owns.transaction(input.transactionId);
    if (input.expectedCurrentNote !== undefined) {
      const [current] = yield* query((db) =>
        db
          .select({ note: schema.transactions.note })
          .from(schema.transactions)
          .where(eq(schema.transactions.id, input.transactionId))
          .limit(1),
      );
      if ((current?.note ?? "").trim() !== (input.expectedCurrentNote ?? "").trim()) {
        return yield* new Conflict({
          message: "The note changed since this card was made. Ask again to get a fresh card.",
        });
      }
    }
    const cleaned = input.note.trim();
    yield* query((db) =>
      db
        .update(schema.transactions)
        .set({ note: cleaned === "" ? null : cleaned })
        .where(
          and(
            eq(schema.transactions.id, input.transactionId),
            eq(schema.transactions.accountId, accountId),
          ),
        ),
    );
  }),
};

const ApplyNoteInput = Schema.Struct({
  transactionIds: Schema.Array(Schema.String),
  note: Schema.String,
});

export const applyNoteToTransactionsSpec: Spec<
  typeof ApplyNoteInput.Type,
  typeof ApplyNoteInput.Encoded,
  { updated: number }
> = {
  input: ApplyNoteInput,
  revalidate: ["/transactions", "/"],
  handler: Effect.fn("applyNoteToTransactions")(function* (input) {
    const cleaned = input.note.trim();
    if (input.transactionIds.length === 0) return { updated: 0 };
    const transactionIds = [...input.transactionIds];
    yield* owns.transactions(transactionIds);
    const updated = yield* query((db) =>
      db
        .update(schema.transactions)
        .set({ note: cleaned === "" ? null : cleaned })
        .where(inArray(schema.transactions.id, transactionIds))
        .returning({ id: schema.transactions.id }),
    );
    return { updated: updated.length };
  }),
};

// ─── autoDetectTransfers ─────────────────────────────────────────────────────

export const autoDetectTransfersSpec: Spec<
  typeof Schema.Void.Type,
  typeof Schema.Void.Encoded,
  { pairs: number }
> = {
  input: Schema.Void,
  // The old code revalidated only "/transactions" when nothing was found.
  revalidate: ["/transactions", "/", "/timeline"],
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
    if (pairs.length === 0) return { pairs: 0 };
    const ids = pairs.flatMap((p) => [p.debitId, p.creditId]);
    yield* query((db) =>
      db
        .update(schema.transactions)
        .set({ isTransfer: true })
        .where(inArray(schema.transactions.id, ids)),
    );
    return { pairs: pairs.length };
  }),
};
