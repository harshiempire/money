import "server-only";
import { Effect, Schema } from "effect";
import type { ActionSpec } from "@/lib/action/core";
import { CurrentUser, type Db } from "@/lib/action/services";
import { fromLedger } from "@/lib/action/ledger";
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
// Shape and types only. The leg RULES (a payable leg uses offset, and carries
// either an existing owedExpenseId or a newPayable, not both and not neither)
// are enforced by the ledger core with clear messages — a stricter union here
// would reject those requests with a cryptic decoding message instead.
const NetEventLegSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("receivable"),
    splitParticipantId: Schema.String,
    amountPaise: Schema.Number,
    method: Schema.Literals(["bank", "offset"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("payable"),
    amountPaise: Schema.Number,
    method: Schema.Literals(["bank", "offset"]),
    owedExpenseId: Schema.optional(Schema.String),
    newPayable: Schema.optional(NewPayableSchema),
  }),
]);

const saveNetEventInput = Schema.Struct({
  netEventId: Schema.optional(Schema.String),
  eventDate: Schema.String,
  inflowTransactionId: Schema.optional(Schema.String),
  outflowTransactionId: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  legs: Schema.Array(NetEventLegSchema),
});
export const saveNetEventSpec: ActionSpec<
  typeof saveNetEventInput.Type,
  typeof saveNetEventInput.Encoded,
  Awaited<ReturnType<typeof saveNetEventForActor>>,
  CurrentUser | Db,
  NonNullable<Awaited<ReturnType<typeof saveNetEventForActor>>["value"]>
> = {
  input: saveNetEventInput,
  revalidate: ["/transactions", "/reimbursements", "/people", "/spend", "/"],
  revalidateWhen: (r) => r.revalidate,
  // The handler fails (as a logged defect) before this if the core returned no value.
  toData: (r) => r.value as NonNullable<typeof r.value>,
  handler: Effect.fn("saveNetEvent")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* fromLedger(() =>
      saveNetEventForActor(
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
          ...(input.note !== undefined ? { note: input.note } : {}),
          // The core validates the leg rules; the cast only widens the union for it.
          legs: input.legs.map((leg) => pickNetEventLeg(leg as NetEventLeg)),
        },
      ),
    );

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
  revalidate: ["/transactions", "/reimbursements", "/people", "/spend", "/"],
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
