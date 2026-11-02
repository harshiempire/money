import "server-only";
import { and, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { schema } from "@/db";
import type { ActionSpec } from "@/lib/action/core";
import { Conflict, Invalid } from "@/lib/action/errors";
import { owns } from "@/lib/action/ownership";
import { query, type CurrentUser, type Db } from "@/lib/action/services";
import { participantOutstanding } from "@/lib/splits/outstanding";

/**
 * Cash settlement / write-off handlers behind ./actions.ts.
 *
 * Translated one statement at a time from the pre-Effect implementations:
 * same queries, same order, same silent no-ops (cash on a missing
 * participant, or nothing left to settle, quietly does nothing; deleting a
 * non-cash settlement deletes nothing), same messages. Revalidation now runs
 * on every success, including those no-op paths.
 *
 * Integration check: scripts/test-reimbursement-actions.ts.
 */

type Spec<I, IEncoded> = ActionSpec<I, IEncoded, void, CurrentUser | Db>;

const CASH_PATHS = ["/reimbursements", "/transactions", "/"] as const;
const WRITEOFF_PATHS = ["/reimbursements", "/transactions", "/people", "/"] as const;

const safePaise = (n: number): number =>
  Number.isFinite(n) ? Math.round(n) : 0;

const trimmedNote = (note: string | null | undefined): string | null =>
  note?.trim() ? note.trim().slice(0, 200) : null;

// ─── recordCashSettlement ────────────────────────────────────────────────────

const RecordCashInput = Schema.Struct({
  splitParticipantId: Schema.String,
  amountPaise: Schema.Number,
  note: Schema.NullOr(Schema.String),
});

export const recordCashSettlementSpec: Spec<
  typeof RecordCashInput.Type,
  typeof RecordCashInput.Encoded
> = {
  input: RecordCashInput,
  revalidate: CASH_PATHS,
  handler: Effect.fn("recordCashSettlement")(function* (input) {
    yield* owns.splitParticipant(input.splitParticipantId);

    const [participant] = yield* query((db) =>
      db
        .select({
          expectedAmountPaise: schema.splitParticipants.expectedAmountPaise,
        })
        .from(schema.splitParticipants)
        .where(eq(schema.splitParticipants.id, input.splitParticipantId))
        .limit(1),
    );
    if (!participant) return;

    const existing = yield* query((db) =>
      db
        .select({ amountPaise: schema.settlements.amountPaise })
        .from(schema.settlements)
        .where(eq(schema.settlements.splitParticipantId, input.splitParticipantId)),
    );

    const alreadySettled = existing.reduce(
      (sum, row) => sum + Number(row.amountPaise),
      0,
    );
    const outstanding = Math.max(
      0,
      Number(participant.expectedAmountPaise) - alreadySettled,
    );
    const amountPaise = Math.min(safePaise(input.amountPaise), outstanding);
    if (amountPaise <= 0) return;

    yield* query((db) =>
      db.insert(schema.settlements).values({
        splitParticipantId: input.splitParticipantId,
        amountPaise,
        method: "cash",
        note: trimmedNote(input.note),
      }),
    );
  }),
};

// ─── deleteCashSettlement ────────────────────────────────────────────────────

const SettlementRef = Schema.Struct({ settlementId: Schema.String });

export const deleteCashSettlementSpec: Spec<
  typeof SettlementRef.Type,
  typeof SettlementRef.Encoded
> = {
  input: SettlementRef,
  revalidate: CASH_PATHS,
  handler: Effect.fn("deleteCashSettlement")(function* (input) {
    yield* owns.settlement(input.settlementId);

    yield* query((db) =>
      db
        .delete(schema.settlements)
        .where(
          and(
            eq(schema.settlements.id, input.settlementId),
            eq(schema.settlements.method, "cash"),
          ),
        ),
    );
  }),
};

// ─── writeOffParticipantShare ────────────────────────────────────────────────

// A writeoff is structurally a settlement like cash — it just records that no
// money moved, so the participant stops reading as outstanding for a shortfall
// you never intended to chase.
const WriteOffInput = Schema.Struct({
  splitParticipantId: Schema.String,
  note: Schema.NullOr(Schema.String),
});

export const writeOffParticipantShareSpec: Spec<
  typeof WriteOffInput.Type,
  typeof WriteOffInput.Encoded
> = {
  input: WriteOffInput,
  revalidate: WRITEOFF_PATHS,
  handler: Effect.fn("writeOffParticipantShare")(function* (input) {
    yield* owns.splitParticipant(input.splitParticipantId);

    const outstanding = yield* Effect.promise(() =>
      participantOutstanding(input.splitParticipantId),
    );
    if (outstanding <= 0) {
      return yield* new Conflict({ message: "Nothing outstanding on this share to forgive." });
    }

    yield* query((db) =>
      db.insert(schema.settlements).values({
        splitParticipantId: input.splitParticipantId,
        amountPaise: outstanding,
        method: "writeoff",
        inflowTransactionId: null,
        note: trimmedNote(input.note),
      }),
    );
  }),
};

// ─── undoWriteOff ────────────────────────────────────────────────────────────

// Reverses a mistaken writeoff. Refuses anything that isn't a writeoff so a
// misclick here can't quietly delete a real cash settlement.
export const undoWriteOffSpec: Spec<
  typeof SettlementRef.Type,
  typeof SettlementRef.Encoded
> = {
  input: SettlementRef,
  revalidate: WRITEOFF_PATHS,
  handler: Effect.fn("undoWriteOff")(function* (input) {
    yield* owns.settlement(input.settlementId);

    const [settlement] = yield* query((db) =>
      db
        .select({ method: schema.settlements.method })
        .from(schema.settlements)
        .where(eq(schema.settlements.id, input.settlementId))
        .limit(1),
    );
    if (!settlement || settlement.method !== "writeoff") {
      return yield* new Invalid({
        message: "This settlement is not a writeoff and cannot be undone here.",
      });
    }

    yield* query((db) =>
      db
        .delete(schema.settlements)
        .where(
          and(
            eq(schema.settlements.id, input.settlementId),
            eq(schema.settlements.method, "writeoff"),
          ),
        ),
    );
  }),
};
