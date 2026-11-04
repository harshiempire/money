import { refreshPaths } from "@/lib/ledger/capabilities";
import "server-only";
import { Effect, Schema } from "effect";
import type { ActionSpec } from "@/lib/action/core";
import { CurrentUser, type Db } from "@/lib/action/services";
import { Actor } from "@/lib/ledger/services";
import { ledgerEffectErrors, fromLedger } from "@/lib/action/ledger";
import { getOrCreateAccountForBank } from "@/db/money-account";
import {
  saveNetEvent as saveNetEventForActor,
  deleteNetEvent as deleteNetEventForActor,
} from "@/lib/ledger/net-events";
import { pickNetEventLeg, type NetEventLeg } from "@/lib/net-events/legs";
const NewPayableSchema = Schema.Struct({
  personName: Schema.String,
  incurredDate: Schema.String,
  amountPaise: Schema.Number,
  description: Schema.String,
  categoryId: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.optional(Schema.NullOr(Schema.String)),
});
// Shape and types only. The leg RULES (a payable leg uses offset or cash, and carries
// either an existing owedExpenseId or a newPayable, not both and not neither)
// are enforced by the ledger core with clear messages — a stricter union here
// would reject those requests with a cryptic decoding message instead.
const NetEventLegSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("receivable"),
    splitParticipantId: Schema.String,
    amountPaise: Schema.Number,
    method: Schema.Literals(["bank", "cash", "offset"]),
    expectedOutstandingPaise: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal("payable"),
    amountPaise: Schema.Number,
    method: Schema.Literals(["bank", "cash", "offset"]),
    expectedOutstandingPaise: Schema.optional(Schema.Number),
    owedExpenseId: Schema.optional(Schema.String),
    newPayable: Schema.optional(NewPayableSchema),
  }),
]);

const saveNetEventInput = Schema.Struct({
  netEventId: Schema.optional(Schema.String),
  eventDate: Schema.optional(Schema.String),
  inflowTransactionId: Schema.optional(Schema.String),
  outflowTransactionId: Schema.optional(Schema.String),
  // main also accepted null (the core normalizes it).
  note: Schema.optional(Schema.NullOr(Schema.String)),
  legs: Schema.Array(NetEventLegSchema),
});
export const saveNetEventSpec: ActionSpec<
  typeof saveNetEventInput.Type,
  typeof saveNetEventInput.Encoded,
  Effect.Success<ReturnType<typeof saveNetEventForActor>>,
  CurrentUser | Db,
  NonNullable<Effect.Success<ReturnType<typeof saveNetEventForActor>>["value"]>
> = {
  input: saveNetEventInput,
  revalidate: refreshPaths("net.save"),
  revalidateWhen: (r) => r.revalidate,
  // The handler fails (as a logged defect) before this if the core returned no value.
  toData: (r) => r.value as NonNullable<typeof r.value>,
  handler: Effect.fn("saveNetEvent")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* saveNetEventForActor(
        { actor: { userId: user.id, accountId: account.id }, source: "app" },
        {
          eventDate: input.eventDate,
          ...(input.netEventId !== undefined
            ? { netEventId: input.netEventId }
            : {}),
          ...(input.inflowTransactionId !== undefined
            ? { inflowTransactionId: input.inflowTransactionId }
            : {}),
          ...(input.outflowTransactionId !== undefined
            ? { outflowTransactionId: input.outflowTransactionId }
            : {}),
          ...(input.note !== undefined ? { note: input.note as string } : {}),
          // The core validates the leg rules; the cast only widens the union for it.
          legs: input.legs.map((leg) => pickNetEventLeg(leg as NetEventLeg)),
        },
      ).pipe(Effect.provideService(Actor, { userId: user.id, accountId: account.id }), ledgerEffectErrors);

    if (result.value === undefined) {
      return yield* Effect.die(new Error("saveNetEvent: the ledger core returned no value"));
    }
    return result;
  }),
};

const deleteNetEventInput = Schema.Struct({ netEventId: Schema.String });
export const deleteNetEventSpec: ActionSpec<
  typeof deleteNetEventInput.Type,
  typeof deleteNetEventInput.Encoded,
  Awaited<ReturnType<typeof deleteNetEventForActor>>,
  CurrentUser | Db,
  void
> = {
  input: deleteNetEventInput,
  revalidate: refreshPaths("net.delete"),
  revalidateWhen: (r) => r.revalidate,
  toData: () => undefined,
  handler: Effect.fn("deleteNetEvent")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* fromLedger(() =>
      deleteNetEventForActor(
        { actor: { userId: user.id, accountId: account.id }, source: "app" },
        {
          netEventId: input.netEventId,
        },
      ),
    );

    return result;
  }),
};
