import "server-only";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { schema } from "@/db";
import { getOrCreatePerson } from "@/db/person";
import type { ActionSpec } from "@/lib/action/core";
import { Conflict, Forbidden, Invalid, NotFound, Unavailable } from "@/lib/action/errors";
import { owns } from "@/lib/action/ownership";
import { CurrentUser, query, transaction, type Db } from "@/lib/action/services";
import {
  owedExpenseOutstanding,
  participantOutstanding,
} from "@/lib/splits/outstanding";
import { validateNetEventInvariant } from "@/lib/net-events/validate";

/**
 * Net Settle handlers behind ./net-event-actions.ts.
 *
 * The bodies are the pre-Effect implementations translated one statement at a
 * time: same checks in the same order (sync leg checks → ownership in
 * parallel → bank amounts → invariant → outstanding in parallel → one write
 * transaction), same queries, same messages. The old NetEventValidationError
 * codes map to: INVALID_LEG / MISSING_BANK_TXN / INVARIANT_MISMATCH → Invalid,
 * OVER_ALLOCATION → Conflict, "Transaction not found" → NotFound. The old
 * connection-timeout rewrite of DB errors is kept, now as Unavailable (the
 * underlying error is logged as a warning, as Next used to log the throw).
 *
 * One deliberate change since the translation: a payable leg carrying BOTH
 * owedExpenseId and newPayable is now rejected (it used to be validated as
 * the existing payable while creating the new one unchecked).
 *
 * Integration check: scripts/test-net-event-actions.ts.
 */

type Spec<I, IEncoded> = ActionSpec<I, IEncoded, void, CurrentUser | Db>;

const ALL_PATHS = ["/transactions", "/reimbursements", "/people", "/spend", "/"] as const;

const safePaise = (n: number): number =>
  Number.isFinite(n) ? Math.round(n) : 0;

// Same test the old try/catch applied to errors from the write transaction.
const isConnectionTrouble = (defect: unknown): boolean => {
  const msg = defect instanceof Error ? defect.message : String(defect);
  return /timeout|terminat|connect/i.test(msg);
};

// ─── input ───────────────────────────────────────────────────────────────────

// Deliberately as loose as the old runtime checks: `method` accepts both
// values on either leg kind so "Payable legs must use offset method" is still
// the error a payable "bank" leg gets, and amounts are Number so safePaise
// normalises them as before. owedExpenseId / newPayable are both optional;
// the handler branches on them exactly as the old code did.
const NewPayable = Schema.Struct({
  personName: Schema.String,
  incurredDate: Schema.String,
  amountPaise: Schema.Number,
  description: Schema.String,
  categoryId: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.optional(Schema.NullOr(Schema.String)),
});

const Method = Schema.Literals(["bank", "offset"]);

const Leg = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("receivable"),
    splitParticipantId: Schema.String,
    amountPaise: Schema.Number,
    method: Method,
  }),
  Schema.Struct({
    kind: Schema.Literal("payable"),
    amountPaise: Schema.Number,
    method: Method,
    owedExpenseId: Schema.optional(Schema.String),
    newPayable: Schema.optional(NewPayable),
  }),
]);

const SaveNetEventInput = Schema.Struct({
  netEventId: Schema.optional(Schema.String),
  eventDate: Schema.String,
  inflowTransactionId: Schema.optional(Schema.String),
  outflowTransactionId: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  legs: Schema.Array(Leg),
});

// ─── helpers ─────────────────────────────────────────────────────────────────

const fetchTransactionAmount = Effect.fnUntraced(function* (transactionId: string) {
  yield* owns.transaction(transactionId);
  const [row] = yield* query((db) =>
    db
      .select({ amountPaise: schema.transactions.amountPaise })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, transactionId))
      .limit(1),
  );
  if (!row) {
    return yield* new NotFound({ message: "Transaction not found" });
  }
  return Number(row.amountPaise);
});

// ─── saveNetEvent ────────────────────────────────────────────────────────────

export const saveNetEventSpec: Spec<
  typeof SaveNetEventInput.Type,
  typeof SaveNetEventInput.Encoded
> = {
  input: SaveNetEventInput,
  revalidate: ALL_PATHS,
  handler: Effect.fn("saveNetEvent")(function* (input) {
    const user = yield* CurrentUser;

    const cleanLegs = input.legs
      .map((leg) => ({
        ...leg,
        amountPaise: safePaise(leg.amountPaise),
      }))
      .filter((leg) => leg.amountPaise > 0);

    if (cleanLegs.length === 0) {
      return yield* new Invalid({ message: "At least one non-zero leg is required" });
    }

    // Sync validation first (no DB), then fan out ownership / outstanding checks.
    for (const leg of cleanLegs) {
      if (leg.kind === "receivable") {
        if (leg.method === "bank" && !input.inflowTransactionId) {
          return yield* new Invalid({
            message: "Bank receivable legs require an inflow transaction",
          });
        }
      } else if (leg.owedExpenseId && leg.newPayable) {
        // Before 2026-11-02 such a leg was validated (and ownership-checked)
        // as the existing payable, yet the transaction still created the new
        // one — skipping its description/amount checks and the ownership
        // check on its categoryId. A leg is one or the other.
        return yield* new Invalid({
          message: "A payable leg must either use an existing payable or create a new one, not both",
        });
      } else if (leg.owedExpenseId) {
        if (leg.method !== "offset") {
          return yield* new Invalid({ message: "Payable legs must use offset method" });
        }
      } else if (leg.newPayable) {
        if (leg.method !== "offset") {
          return yield* new Invalid({ message: "Payable legs must use offset method" });
        }
        const description = leg.newPayable.description.trim();
        if (!description) {
          return yield* new Invalid({ message: "New payable description is required" });
        }
        if (leg.newPayable.amountPaise <= 0) {
          return yield* new Invalid({ message: "New payable amount must be positive" });
        }
        if (leg.amountPaise > leg.newPayable.amountPaise) {
          return yield* new Conflict({
            message: `Payable leg exceeds new expense amount by ${(leg.amountPaise - leg.newPayable.amountPaise) / 100}`,
          });
        }
      } else {
        return yield* new Invalid({
          message: "Payable leg requires owedExpenseId or newPayable",
        });
      }
    }

    // All ownership checks at once, as before (Promise.all).
    const ownershipChecks: Array<Effect.Effect<unknown, Forbidden, CurrentUser>> = [];
    if (input.inflowTransactionId) {
      ownershipChecks.push(owns.transaction(input.inflowTransactionId));
    }
    if (input.outflowTransactionId) {
      ownershipChecks.push(owns.transaction(input.outflowTransactionId));
    }
    if (input.netEventId) {
      ownershipChecks.push(owns.netEvent(input.netEventId));
    }
    for (const leg of cleanLegs) {
      if (leg.kind === "receivable") {
        ownershipChecks.push(owns.splitParticipant(leg.splitParticipantId));
      } else if (leg.owedExpenseId) {
        ownershipChecks.push(owns.owedExpense(leg.owedExpenseId));
      } else if (leg.newPayable?.categoryId) {
        ownershipChecks.push(owns.category(leg.newPayable.categoryId));
      }
    }
    yield* Effect.all(ownershipChecks, { concurrency: "unbounded", discard: true });

    const [inflowAmount, outflowAmount] = yield* Effect.all(
      [
        input.inflowTransactionId
          ? fetchTransactionAmount(input.inflowTransactionId)
          : Effect.succeed(0),
        input.outflowTransactionId
          ? fetchTransactionAmount(input.outflowTransactionId)
          : Effect.succeed(0),
      ],
      { concurrency: "unbounded" },
    );

    const invariant = validateNetEventInvariant(cleanLegs, inflowAmount, outflowAmount);
    if (!invariant.ok) {
      return yield* new Invalid({ message: invariant.message });
    }

    yield* Effect.all(
      cleanLegs.map((leg) =>
        Effect.gen(function* () {
          if (leg.kind === "receivable") {
            const outstanding = yield* Effect.promise(() =>
              participantOutstanding(leg.splitParticipantId, input.netEventId),
            );
            if (leg.amountPaise > outstanding) {
              return yield* new Conflict({
                message: `Receivable leg exceeds outstanding by ${(leg.amountPaise - outstanding) / 100}`,
              });
            }
          } else if (leg.owedExpenseId) {
            const owedExpenseId = leg.owedExpenseId;
            const outstanding = yield* Effect.promise(() =>
              owedExpenseOutstanding(owedExpenseId, input.netEventId),
            );
            if (leg.amountPaise > outstanding) {
              return yield* new Conflict({
                message: `Payable leg exceeds outstanding by ${(leg.amountPaise - outstanding) / 100}`,
              });
            }
          }
        }),
      ),
      { concurrency: "unbounded", discard: true },
    );

    yield* transaction((tx) =>
      Effect.gen(function* () {
        if (input.netEventId) {
          const netEventId = input.netEventId;
          yield* Effect.promise(() =>
            tx.delete(schema.settlements).where(eq(schema.settlements.netEventId, netEventId)),
          );
          yield* Effect.promise(() =>
            tx.delete(schema.netEvents).where(eq(schema.netEvents.id, netEventId)),
          );
        }

        const [event] = yield* Effect.promise(() =>
          tx
            .insert(schema.netEvents)
            .values({
              userId: user.id,
              eventDate: input.eventDate,
              inflowTransactionId: input.inflowTransactionId ?? null,
              outflowTransactionId: input.outflowTransactionId ?? null,
              note: input.note?.trim() ? input.note.trim().slice(0, 200) : null,
            })
            .returning({ id: schema.netEvents.id }),
        );

        const settlementRows: Array<typeof schema.settlements.$inferInsert> = [];
        for (const leg of cleanLegs) {
          if (leg.kind === "receivable") {
            settlementRows.push({
              netEventId: event.id,
              splitParticipantId: leg.splitParticipantId,
              owedExpenseId: null,
              amountPaise: leg.amountPaise,
              method: leg.method,
              inflowTransactionId:
                leg.method === "bank" ? (input.inflowTransactionId ?? null) : null,
            });
            continue;
          }

          let owedExpenseId = leg.owedExpenseId;
          if (leg.newPayable) {
            const newPayable = leg.newPayable;
            const personId = yield* Effect.promise(() =>
              getOrCreatePerson(user.id, newPayable.personName, tx),
            );
            const [created] = yield* Effect.promise(() =>
              tx
                .insert(schema.owedExpenses)
                .values({
                  userId: user.id,
                  personId,
                  personName: newPayable.personName.trim(),
                  incurredDate: newPayable.incurredDate,
                  amountPaise: newPayable.amountPaise,
                  description: newPayable.description.trim(),
                  categoryId: newPayable.categoryId ?? null,
                  note: newPayable.note?.trim()
                    ? newPayable.note.trim().slice(0, 200)
                    : null,
                })
                .returning({ id: schema.owedExpenses.id }),
            );
            owedExpenseId = created.id;
          }

          settlementRows.push({
            netEventId: event.id,
            splitParticipantId: null,
            owedExpenseId,
            amountPaise: leg.amountPaise,
            method: "offset" as const,
            inflowTransactionId: null,
          });
        }

        yield* Effect.promise(() => tx.insert(schema.settlements).values(settlementRows));
      }),
    ).pipe(
      Effect.catchDefect((defect) =>
        isConnectionTrouble(defect)
          ? Effect.logWarning("saveNetEvent: database connection trouble", defect).pipe(
              Effect.andThen(
                Effect.fail(
                  new Unavailable({
                    message:
                      "Database connection timed out while saving. Please try again in a moment.",
                  }),
                ),
              ),
            )
          : Effect.die(defect),
      ),
    );
  }),
};

// ─── deleteNetEvent ──────────────────────────────────────────────────────────

const NetEventRef = Schema.Struct({ netEventId: Schema.String });

export const deleteNetEventSpec: Spec<
  typeof NetEventRef.Type,
  typeof NetEventRef.Encoded
> = {
  input: NetEventRef,
  revalidate: ALL_PATHS,
  handler: Effect.fn("deleteNetEvent")(function* (input) {
    yield* owns.netEvent(input.netEventId);

    yield* transaction((tx) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          tx
            .delete(schema.settlements)
            .where(eq(schema.settlements.netEventId, input.netEventId)),
        );
        yield* Effect.promise(() =>
          tx.delete(schema.netEvents).where(eq(schema.netEvents.id, input.netEventId)),
        );
      }),
    ).pipe(
      Effect.catchDefect((defect) =>
        isConnectionTrouble(defect)
          ? Effect.logWarning("deleteNetEvent: database connection trouble", defect).pipe(
              Effect.andThen(
                Effect.fail(
                  new Unavailable({
                    message: "Database connection timed out while reversing. Please try again.",
                  }),
                ),
              ),
            )
          : Effect.die(defect),
      ),
    );
  }),
};
