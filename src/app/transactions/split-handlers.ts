import "server-only";
import { Effect, Schema } from "effect";
import type { ActionSpec } from "@/lib/action/core";
import { CurrentUser, type Db } from "@/lib/action/services";
import { fromLedger } from "@/lib/action/ledger";
import { getOrCreateAccountForBank } from "@/db/money-account";
import {
  createSplit as createSplitForActor,
  deleteSplit as deleteSplitForActor,
  recordSettlement as recordSettlementForActor,
  clearSettlement as clearSettlementForActor,
} from "@/lib/ledger/splits";
import { pickParticipantInput } from "@/lib/splits/types";
const ParticipantInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  personName: Schema.String,
  expectedAmountPaise: Schema.Number,
});

const createSplitInput = Schema.Struct({
  transactionId: Schema.String,
  totalPaise: Schema.Number,
  yourSharePaise: Schema.Number,
  // main accepted an omitted note and forwarded it as undefined (an edit then
  // keeps the existing note); kept the same way below.
  note: Schema.optional(Schema.NullOr(Schema.String)),
  participants: Schema.Array(ParticipantInputSchema),
  expectNoExistingSplit: Schema.optional(Schema.Boolean),
});
export const createSplitSpec: ActionSpec<
  typeof createSplitInput.Type,
  typeof createSplitInput.Encoded,
  Awaited<ReturnType<typeof createSplitForActor>>,
  CurrentUser | Db,
  void
> = {
  input: createSplitInput,
  revalidate: ["/transactions", "/reimbursements", "/"],
  revalidateWhen: (r) => r.revalidate,
  toData: () => undefined,
  handler: Effect.fn("createSplit")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* fromLedger(() =>
      createSplitForActor(
        { actor: { userId: user.id, accountId: account.id }, source: "app" },
        {
          transactionId: input.transactionId,
          totalPaise: input.totalPaise,
          yourSharePaise: input.yourSharePaise,
          note: input.note as string | null,
          ...(input.expectNoExistingSplit !== undefined
            ? { expectNoExistingSplit: input.expectNoExistingSplit }
            : {}),
          participants: input.participants.map(pickParticipantInput),
        },
      ),
    );

    return result;
  }),
};

const deleteSplitInput = Schema.Struct({
  transactionId: Schema.String,
  expectNoSettlements: Schema.optional(Schema.Boolean),
});
export const deleteSplitSpec: ActionSpec<
  typeof deleteSplitInput.Type,
  typeof deleteSplitInput.Encoded,
  Awaited<ReturnType<typeof deleteSplitForActor>>,
  CurrentUser | Db,
  void
> = {
  input: deleteSplitInput,
  revalidate: ["/transactions", "/reimbursements", "/people", "/"],
  revalidateWhen: (r) => r.revalidate,
  toData: () => undefined,
  handler: Effect.fn("deleteSplit")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* fromLedger(() =>
      deleteSplitForActor(
        { actor: { userId: user.id, accountId: account.id }, source: "app" },
        {
          transactionId: input.transactionId,
          ...(input.expectNoSettlements !== undefined
            ? { expectNoSettlements: input.expectNoSettlements }
            : {}),
        },
      ),
    );

    return result;
  }),
};

const recordSettlementInput = Schema.Struct({
  inflowTransactionId: Schema.String,
  allocations: Schema.Array(
    Schema.Struct({
      splitParticipantId: Schema.String,
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
export const recordSettlementSpec: ActionSpec<
  typeof recordSettlementInput.Type,
  typeof recordSettlementInput.Encoded,
  Awaited<ReturnType<typeof recordSettlementForActor>>,
  CurrentUser | Db,
  void
> = {
  input: recordSettlementInput,
  revalidate: ["/transactions", "/reimbursements", "/people", "/"],
  revalidateWhen: (r) => r.revalidate,
  toData: () => undefined,
  handler: Effect.fn("recordSettlement")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* fromLedger(() =>
      recordSettlementForActor(
        { actor: { userId: user.id, accountId: account.id }, source: "app" },
        {
          inflowTransactionId: input.inflowTransactionId,
          allocations: input.allocations.map((row) => ({
            splitParticipantId: row.splitParticipantId,
            amountPaise: row.amountPaise,
          })),
          ...(input.residual !== undefined
            ? {
                residual:
                  input.residual === null
                    ? null
                    : {
                        kind: input.residual.kind,
                        ...(input.residual.personName !== undefined
                          ? { personName: input.residual.personName }
                          : {}),
                        ...(input.residual.note !== undefined
                          ? { note: input.residual.note }
                          : {}),
                      },
              }
            : {}),
        },
      ),
    );

    return result;
  }),
};

const clearSettlementInput = Schema.Struct({
  inflowTransactionId: Schema.String,
});
export const clearSettlementSpec: ActionSpec<
  typeof clearSettlementInput.Type,
  typeof clearSettlementInput.Encoded,
  Awaited<ReturnType<typeof clearSettlementForActor>>,
  CurrentUser | Db,
  void
> = {
  input: clearSettlementInput,
  revalidate: ["/transactions", "/reimbursements", "/people", "/"],
  revalidateWhen: (r) => r.revalidate,
  toData: () => undefined,
  handler: Effect.fn("clearSettlement")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* fromLedger(() =>
      clearSettlementForActor(
        { actor: { userId: user.id, accountId: account.id }, source: "app" },
        {
          inflowTransactionId: input.inflowTransactionId,
        },
      ),
    );

    return result;
  }),
};
