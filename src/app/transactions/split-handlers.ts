import "server-only";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { schema } from "@/db";
import { getOrCreatePerson } from "@/db/person";
import type { ActionSpec } from "@/lib/action/core";
import { Conflict, Invalid } from "@/lib/action/errors";
import { owns } from "@/lib/action/ownership";
import { CurrentUser, query, transaction, type Db } from "@/lib/action/services";
import { check, checkState } from "@/lib/action/validation";
import {
  settledAmountByOwedExpenseIds,
  settledAmountByParticipantIds,
} from "@/lib/splits/outstanding";
import {
  cleanAllocations,
  validateInflowCapacity,
  validateParticipantIdsBelongToSplit,
  validatePayableReplaceable,
  validateSettledParticipantEdit,
  validateSettlementSource,
  validateSplitInput,
  validateSplitTotalMatchesTransaction,
} from "@/lib/splits/validate";

/**
 * Split / settlement handlers behind ./split-actions.ts.
 *
 * Kept outside the "use server" file so scripts and tests can run them with
 * their own CurrentUser / Db layers. Nothing here is callable from the
 * browser except through defineAction in split-actions.ts.
 *
 * The bodies are the pre-Effect implementations translated one statement at a
 * time: same queries, same order, same validator calls, same messages. Only
 * the failure channel changed (typed errors instead of `throw new Error`).
 * Verified 2026-11-02 by running old and new side by side against the
 * local-dev branch: identical rows after every step of a 22-step scenario.
 * Known differences: a not-yours id reads "You don't have access to that."
 * (was "Forbidden"), a helper's thrown error (e.g. getOrCreatePerson on a
 * blank name) is a generic INTERNAL message (both were digest-masked in
 * production), and deleteSplit's no-split path now revalidates its paths.
 *
 * Integration check: scripts/test-split-actions.ts (bun run test:split-actions).
 */

type Spec<I, IEncoded> = ActionSpec<I, IEncoded, void, CurrentUser | Db>;

const SPLIT_PATHS = ["/transactions", "/reimbursements", "/"] as const;
const SETTLEMENT_PATHS = ["/transactions", "/reimbursements", "/people", "/"] as const;

const safePaise = (n: number, fallback = 0): number =>
  Number.isFinite(n) ? Math.round(n) : fallback;

const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

// ─── createSplit ─────────────────────────────────────────────────────────────

// Number (not Int/Finite) on purpose: non-finite amounts are normalised by
// safePaise below, exactly as before decoding existed.
const ParticipantInput = Schema.Struct({
  // Existing participant id — pass back what the dialog was given for rows
  // that were kept, so the row (and its settlements) survive an edit.
  id: Schema.optional(Schema.String),
  personName: Schema.String,
  expectedAmountPaise: Schema.Number,
});
export type ParticipantInput = typeof ParticipantInput.Type;

const CreateSplitInput = Schema.Struct({
  transactionId: Schema.String,
  totalPaise: Schema.Number,
  yourSharePaise: Schema.Number,
  note: Schema.NullOr(Schema.String),
  participants: Schema.Array(ParticipantInput),
  /** Refuse instead of editing when a split already exists (assistant cards). */
  expectNoExistingSplit: Schema.optional(Schema.Boolean),
});

export const createSplitSpec: Spec<
  typeof CreateSplitInput.Type,
  typeof CreateSplitInput.Encoded
> = {
  input: CreateSplitInput,
  revalidate: SPLIT_PATHS,
  handler: Effect.fn("createSplit")(function* (input) {
    const user = yield* CurrentUser;
    yield* owns.transaction(input.transactionId);

    const cleanParticipants = input.participants.map((p) => ({
      id: p.id,
      personName: p.personName,
      expectedAmountPaise: safePaise(p.expectedAmountPaise),
    }));
    const totalPaise = safePaise(input.totalPaise);
    const participantsSum = cleanParticipants.reduce(
      (s, p) => s + p.expectedAmountPaise,
      0,
    );
    const yourSharePaise = safePaise(
      input.yourSharePaise,
      Math.max(0, totalPaise - participantsSum),
    );

    yield* check(
      validateSplitInput({
        totalPaise,
        yourSharePaise,
        participants: cleanParticipants,
      }),
    );

    // A split divides money you paid out. Splitting an incoming credit would
    // record a share of a payment that never happened.
    const [subject] = yield* query((db) =>
      db
        .select({
          drCr: schema.transactions.drCr,
          amountPaise: schema.transactions.amountPaise,
        })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, input.transactionId))
        .limit(1),
    );
    if (subject?.drCr !== "debit") {
      return yield* new Invalid({ message: "Only a payment you made can be split." });
    }

    // The total isn't the client's to decide — it is the transaction's amount.
    yield* check(
      validateSplitTotalMatchesTransaction({
        totalPaise,
        transactionAmountPaise: Number(subject.amountPaise),
      }),
    );

    const [existingSplit] = yield* query((db) =>
      db
        .select({ id: schema.splits.id })
        .from(schema.splits)
        .where(eq(schema.splits.transactionId, input.transactionId))
        .limit(1),
    );
    if (existingSplit && input.expectNoExistingSplit) {
      return yield* new Conflict({
        message:
          "This payment already has a split. Edit it from the Split button in the table so settlements aren't lost.",
      });
    }

    // Read-only guard against destroying settled money. Must run before the
    // write transaction opens — settledAmountByParticipantIds queries the
    // global `db`, not a tx client.
    let existingParticipants: Array<{
      id: string;
      personName: string;
      expectedAmountPaise: number;
    }> = [];
    if (existingSplit) {
      existingParticipants = (
        yield* query((db) =>
          db
            .select({
              id: schema.splitParticipants.id,
              personName: schema.splitParticipants.personName,
              expectedAmountPaise: schema.splitParticipants.expectedAmountPaise,
            })
            .from(schema.splitParticipants)
            .where(eq(schema.splitParticipants.splitId, existingSplit.id)),
        )
      ).map((p) => ({ ...p, expectedAmountPaise: Number(p.expectedAmountPaise) }));
    }

    // Every id the client sent back must be a row on this split. Ownership of
    // the transaction is already established; this pins the participant rows
    // to it too, instead of quietly treating a foreign id as a brand-new row.
    yield* check(
      validateParticipantIdsBelongToSplit(
        cleanParticipants,
        new Set(existingParticipants.map((p) => p.id)),
      ),
    );

    if (existingParticipants.length > 0) {
      const settledByParticipant = yield* Effect.promise(() =>
        settledAmountByParticipantIds(existingParticipants.map((p) => p.id)),
      );
      const keptById = new Map(
        cleanParticipants
          .filter((p) => p.id)
          .map((p) => [p.id as string, p] as const),
      );

      for (const ep of existingParticipants) {
        yield* checkState(
          validateSettledParticipantEdit({
            existing: ep,
            kept: keptById.get(ep.id),
            settledPaise: settledByParticipant.get(ep.id) ?? 0,
          }),
        );
      }
    }

    yield* transaction((tx) =>
      Effect.gen(function* () {
        let splitId: string;
        if (existingSplit) {
          splitId = existingSplit.id;
          yield* Effect.promise(() =>
            tx
              .update(schema.splits)
              .set({ totalPaise, yourSharePaise, note: input.note })
              .where(eq(schema.splits.id, splitId)),
          );
        } else {
          const [split] = yield* Effect.promise(() =>
            tx
              .insert(schema.splits)
              .values({
                transactionId: input.transactionId,
                totalPaise,
                yourSharePaise,
                note: input.note,
              })
              .returning({ id: schema.splits.id }),
          );
          splitId = split.id;
        }

        const existingById = new Map(existingParticipants.map((p) => [p.id, p]));
        const keepIds = new Set<string>();
        for (const p of cleanParticipants) {
          const personId = yield* Effect.promise(() =>
            getOrCreatePerson(user.id, p.personName, tx),
          );
          if (p.id && existingById.has(p.id)) {
            keepIds.add(p.id);
            const participantId = p.id;
            yield* Effect.promise(() =>
              tx
                .update(schema.splitParticipants)
                .set({
                  personName: p.personName,
                  personId,
                  expectedAmountPaise: p.expectedAmountPaise,
                })
                .where(eq(schema.splitParticipants.id, participantId)),
            );
          } else {
            yield* Effect.promise(() =>
              tx.insert(schema.splitParticipants).values({
                splitId,
                personId,
                personName: p.personName,
                expectedAmountPaise: p.expectedAmountPaise,
              }),
            );
          }
        }

        for (const ep of existingParticipants) {
          if (!keepIds.has(ep.id)) {
            yield* Effect.promise(() =>
              tx
                .delete(schema.splitParticipants)
                .where(eq(schema.splitParticipants.id, ep.id)),
            );
          }
        }
      }),
    );
  }),
};

// ─── deleteSplit ─────────────────────────────────────────────────────────────

const DeleteSplitInput = Schema.Struct({
  transactionId: Schema.String,
  /** Refuse if any money was settled against the split (assistant Undo). */
  expectNoSettlements: Schema.optional(Schema.Boolean),
});

export const deleteSplitSpec: Spec<
  typeof DeleteSplitInput.Type,
  typeof DeleteSplitInput.Encoded
> = {
  input: DeleteSplitInput,
  revalidate: SETTLEMENT_PATHS,
  handler: Effect.fn("deleteSplit")(function* (input) {
    yield* owns.transaction(input.transactionId);

    const existing = yield* query((db) =>
      db
        .select({ id: schema.splits.id })
        .from(schema.splits)
        .where(eq(schema.splits.transactionId, input.transactionId)),
    );
    if (existing.length === 0) return;

    // Deleting the split cascades its participants and their settlements away.
    // Any credit that was settling one of them had its leftover measured
    // against those allocations, so that figure is about to become a claim
    // about money we can no longer account for — collect the credits now,
    // while the settlements still exist, and reset them below.
    const participants = yield* query((db) =>
      db
        .select({ id: schema.splitParticipants.id })
        .from(schema.splitParticipants)
        .where(
          inArray(
            schema.splitParticipants.splitId,
            existing.map((s) => s.id),
          ),
        ),
    );

    let affectedInflowIds: string[] = [];
    if (participants.length > 0) {
      const rows = yield* query((db) =>
        db
          .select({ inflowTransactionId: schema.settlements.inflowTransactionId })
          .from(schema.settlements)
          .where(
            inArray(
              schema.settlements.splitParticipantId,
              participants.map((p) => p.id),
            ),
          ),
      );
      if (input.expectNoSettlements && rows.length > 0) {
        return yield* new Conflict({
          message: "Money was settled against this split since. Remove it from the table instead.",
        });
      }
      affectedInflowIds = [
        ...new Set(
          rows
            .map((r) => r.inflowTransactionId)
            .filter((id): id is string => id !== null),
        ),
      ];
    }

    yield* transaction((tx) =>
      Effect.gen(function* () {
        for (const s of existing) {
          yield* Effect.promise(() =>
            tx.delete(schema.splits).where(eq(schema.splits.id, s.id)),
          );
        }
        // The payables stay: money you owe someone doesn't stop being owed
        // because the split it came from was removed. Only the acknowledgement,
        // whose amount was derived from the deleted allocations, is reset — the
        // credit goes back to reading as unexplained so it gets answered again.
        if (affectedInflowIds.length > 0) {
          yield* Effect.promise(() =>
            tx
              .update(schema.transactions)
              .set({ residualDisposition: null, residualAcknowledgedPaise: null })
              .where(inArray(schema.transactions.id, affectedInflowIds)),
          );
        }
      }),
    );
  }),
};

// ─── shared guard ────────────────────────────────────────────────────────────

/**
 * Replacing a credit's leftover deletes the payable an overpayment created,
 * and `settlement.owed_expense_id` cascades — so any record of that payable
 * being repaid would go with it. Refuse instead, the same way removing a
 * settled participant is refused.
 */
const assertResidualPayableReplaceable = Effect.fnUntraced(function* (
  inflowTransactionId: string,
): Effect.fn.Return<void, Conflict, Db> {
  const payables = yield* query((db) =>
    db
      .select({
        id: schema.owedExpenses.id,
        personName: schema.owedExpenses.personName,
      })
      .from(schema.owedExpenses)
      .where(
        eq(schema.owedExpenses.sourceInflowTransactionId, inflowTransactionId),
      ),
  );
  if (payables.length === 0) return;

  const settled = yield* Effect.promise(() =>
    settledAmountByOwedExpenseIds(payables.map((e) => e.id)),
  );
  for (const payable of payables) {
    yield* checkState(
      validatePayableReplaceable({
        personName: payable.personName,
        settledPaise: settled.get(payable.id) ?? 0,
      }),
    );
  }
});

// ─── recordSettlement ────────────────────────────────────────────────────────

const RecordSettlementInput = Schema.Struct({
  inflowTransactionId: Schema.String,
  allocations: Schema.Array(
    Schema.Struct({
      splitParticipantId: Schema.String,
      // Number on purpose: cleanAllocations reports bad amounts with its own
      // message, as before.
      amountPaise: Schema.Number,
    }),
  ),
  residual: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        kind: Schema.Literals(["owed_back", "kept", "written_off"]),
        personName: Schema.optional(Schema.String),
        note: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

export const recordSettlementSpec: Spec<
  typeof RecordSettlementInput.Type,
  typeof RecordSettlementInput.Encoded
> = {
  input: RecordSettlementInput,
  revalidate: SETTLEMENT_PATHS,
  handler: Effect.fn("recordSettlement")(function* (input) {
    const user = yield* CurrentUser;
    yield* owns.transaction(input.inflowTransactionId);

    for (const a of input.allocations) {
      yield* owns.splitParticipant(a.splitParticipantId);
    }

    // Validate the raw amounts before any row is dropped — a negative or
    // non-numeric amount must fail the request, not vanish and leave an empty
    // list that then wipes the credit's existing allocations.
    const cleaned = cleanAllocations(
      input.allocations.map((a) => ({
        splitParticipantId: a.splitParticipantId,
        amountPaise: a.amountPaise,
      })),
    );
    if (!cleaned.ok) return yield* new Invalid({ message: cleaned.message });
    const allocations = cleaned.allocations;

    // The outstanding/inflow reads below happen before the write transaction and
    // take no row locks, so two settlements saved at the same instant could each
    // see the same amount as unspent. Single-user app, one browser session — the
    // window doesn't arise in practice. Take row locks here if that changes.

    const [inflow] = yield* query((db) =>
      db
        .select({
          amountPaise: schema.transactions.amountPaise,
          txnDate: schema.transactions.txnDate,
          drCr: schema.transactions.drCr,
        })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, input.inflowTransactionId))
        .limit(1),
    );

    yield* check(validateSettlementSource(inflow?.drCr));

    yield* assertResidualPayableReplaceable(input.inflowTransactionId);

    const inflowAmountPaise = inflow ? Number(inflow.amountPaise) : 0;

    // A Net Settle can spend part of this same credit through a bank leg. Those
    // rows carry a net_event_id and belong to the net event, not to this
    // dialog: this action never deletes them, and can only allocate what they
    // left over.
    const netRowsOnInflow = yield* query((db) =>
      db
        .select({ amountPaise: schema.settlements.amountPaise })
        .from(schema.settlements)
        .where(
          and(
            eq(schema.settlements.inflowTransactionId, input.inflowTransactionId),
            isNotNull(schema.settlements.netEventId),
          ),
        ),
    );
    const reservedByNetSettlePaise = netRowsOnInflow.reduce(
      (s, r) => s + Number(r.amountPaise),
      0,
    );

    const allocationsSum = allocations.reduce((s, a) => s + a.amountPaise, 0);
    yield* checkState(
      validateInflowCapacity({
        inflowAmountPaise,
        reservedByNetSettlePaise,
        allocationsSumPaise: allocationsSum,
      }),
    );

    if (allocations.length > 0) {
      const participantIds = [
        ...new Set(allocations.map((a) => a.splitParticipantId)),
      ];
      const participants = yield* query((db) =>
        db
          .select({
            id: schema.splitParticipants.id,
            personName: schema.splitParticipants.personName,
            expectedAmountPaise: schema.splitParticipants.expectedAmountPaise,
          })
          .from(schema.splitParticipants)
          .where(inArray(schema.splitParticipants.id, participantIds)),
      );
      const participantById = new Map(participants.map((p) => [p.id, p]));

      // Settled totals against these participants, excluding the rows this
      // action is about to replace: this inflow's own plain settlements. Net
      // Settle rows on this inflow stay put, so they still count.
      const settledExcludingThisInflow = new Map<string, number>();
      const priorSettlements = yield* query((db) =>
        db
          .select({
            splitParticipantId: schema.settlements.splitParticipantId,
            amountPaise: schema.settlements.amountPaise,
            inflowTransactionId: schema.settlements.inflowTransactionId,
            netEventId: schema.settlements.netEventId,
          })
          .from(schema.settlements)
          .where(inArray(schema.settlements.splitParticipantId, participantIds)),
      );
      for (const row of priorSettlements) {
        if (!row.splitParticipantId) continue;
        if (
          row.inflowTransactionId === input.inflowTransactionId &&
          row.netEventId === null
        ) {
          continue;
        }
        settledExcludingThisInflow.set(
          row.splitParticipantId,
          (settledExcludingThisInflow.get(row.splitParticipantId) ?? 0) +
            Number(row.amountPaise),
        );
      }

      const allocationByParticipant = new Map<string, number>();
      for (const a of allocations) {
        allocationByParticipant.set(
          a.splitParticipantId,
          (allocationByParticipant.get(a.splitParticipantId) ?? 0) +
            a.amountPaise,
        );
      }

      for (const [participantId, allocated] of allocationByParticipant) {
        const participant = participantById.get(participantId);
        if (!participant) continue;
        const expected = Number(participant.expectedAmountPaise);
        const settled = settledExcludingThisInflow.get(participantId) ?? 0;
        const outstanding = Math.max(0, expected - settled);
        if (allocated > outstanding) {
          return yield* new Conflict({
            message: `Allocation of ${rupees(allocated)} to ${participant.personName} exceeds their outstanding balance of ${rupees(outstanding)}.`,
          });
        }
      }
    }

    yield* transaction((tx) =>
      Effect.gen(function* () {
        // Only this dialog's own rows. A row with a net_event_id was written by
        // Net Settle and is deleted only through that event.
        yield* Effect.promise(() =>
          tx
            .delete(schema.settlements)
            .where(
              and(
                eq(schema.settlements.inflowTransactionId, input.inflowTransactionId),
                isNull(schema.settlements.netEventId),
              ),
            ),
        );

        if (allocations.length > 0) {
          yield* Effect.promise(() =>
            tx.insert(schema.settlements).values(
              allocations.map((a) => ({
                inflowTransactionId: input.inflowTransactionId,
                splitParticipantId: a.splitParticipantId,
                amountPaise: a.amountPaise,
                method: "bank" as const,
              })),
            ),
          );
        }

        // Clear any previous disposition first so re-saving is idempotent and
        // switching your answer (e.g. "kept" -> "owed back") doesn't leave a
        // stale owed_expense or acknowledgement behind.
        yield* Effect.promise(() =>
          tx
            .delete(schema.owedExpenses)
            .where(
              eq(
                schema.owedExpenses.sourceInflowTransactionId,
                input.inflowTransactionId,
              ),
            ),
        );
        yield* Effect.promise(() =>
          tx
            .update(schema.transactions)
            .set({ residualDisposition: null, residualAcknowledgedPaise: null })
            .where(eq(schema.transactions.id, input.inflowTransactionId)),
        );

        const residualPaise =
          inflowAmountPaise - reservedByNetSettlePaise - allocationsSum;
        if (input.residual && residualPaise > 0) {
          const residual = input.residual;
          if (residual.kind === "owed_back") {
            const personName = residual.personName?.trim();
            if (!personName) {
              // Inside the transaction, as before: failing here rolls back the
              // deletes above.
              return yield* new Invalid({
                message:
                  "A person name is required to record an overpayment as owed back.",
              });
            }
            const personId = yield* Effect.promise(() =>
              getOrCreatePerson(user.id, personName, tx),
            );
            yield* Effect.promise(() =>
              tx.insert(schema.owedExpenses).values({
                userId: user.id,
                personId,
                personName,
                incurredDate:
                  inflow?.txnDate ?? new Date().toISOString().slice(0, 10),
                amountPaise: residualPaise,
                description: `Overpayment from ${personName}`,
                note: residual.note ?? null,
                sourceInflowTransactionId: input.inflowTransactionId,
              }),
            );
          } else {
            const kind = residual.kind;
            yield* Effect.promise(() =>
              tx
                .update(schema.transactions)
                .set({
                  residualDisposition: kind,
                  residualAcknowledgedPaise: residualPaise,
                })
                .where(eq(schema.transactions.id, input.inflowTransactionId)),
            );
          }
        }
      }),
    );
  }),
};

// ─── clearSettlement ─────────────────────────────────────────────────────────

const InflowRef = Schema.Struct({ inflowTransactionId: Schema.String });

export const clearSettlementSpec: Spec<
  typeof InflowRef.Type,
  typeof InflowRef.Encoded
> = {
  input: InflowRef,
  revalidate: SETTLEMENT_PATHS,
  handler: Effect.fn("clearSettlement")(function* (input) {
    yield* owns.transaction(input.inflowTransactionId);
    yield* assertResidualPayableReplaceable(input.inflowTransactionId);

    yield* transaction((tx) =>
      Effect.gen(function* () {
        // Same scope as recordSettlement: Net Settle's rows on this credit are
        // not this dialog's to clear.
        yield* Effect.promise(() =>
          tx
            .delete(schema.settlements)
            .where(
              and(
                eq(schema.settlements.inflowTransactionId, input.inflowTransactionId),
                isNull(schema.settlements.netEventId),
              ),
            ),
        );
        // Clearing the settlement should not leave an orphan overpayment payable
        // or a stale acknowledged amount behind — the credit goes back to
        // reading as unexplained.
        yield* Effect.promise(() =>
          tx
            .delete(schema.owedExpenses)
            .where(
              eq(
                schema.owedExpenses.sourceInflowTransactionId,
                input.inflowTransactionId,
              ),
            ),
        );
        yield* Effect.promise(() =>
          tx
            .update(schema.transactions)
            .set({ residualDisposition: null, residualAcknowledgedPaise: null })
            .where(eq(schema.transactions.id, input.inflowTransactionId)),
        );
      }),
    );
  }),
};
