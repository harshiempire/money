import "server-only";
import { Effect, Schema } from "effect";
import type { ActionSpec } from "@/lib/action/core";
import { CurrentUser, type Db } from "@/lib/action/services";
import { Actor } from "@/lib/ledger/services";
import { ledgerEffectErrors } from "@/lib/action/ledger";
import { fromLedger } from "@/lib/action/ledger";
import { getOrCreateAccountForBank } from "@/db/money-account";
import {
  recordCashSettlement as recordCashSettlementForActor,
  deleteCashSettlement as deleteCashSettlementForActor,
  writeOffParticipantShare as writeOffParticipantShareForActor,
  undoWriteOff as undoWriteOffForActor,
} from "@/lib/ledger/settlements";

const recordCashSettlementInput = Schema.Struct({
  splitParticipantId: Schema.String,
  amountPaise: Schema.Number,
  // main tolerated an omitted note (the core normalizes it).
  note: Schema.optional(Schema.NullOr(Schema.String)),
});
export const recordCashSettlementSpec: ActionSpec<
  typeof recordCashSettlementInput.Type,
  typeof recordCashSettlementInput.Encoded,
  Effect.Success<ReturnType<typeof recordCashSettlementForActor>>,
  CurrentUser | Db,
  Effect.Success<ReturnType<typeof recordCashSettlementForActor>>["value"]
> = {
  input: recordCashSettlementInput,
  revalidate: ["/reimbursements", "/transactions", "/"],
  revalidateWhen: (r) => r.revalidate,
  toData: (r) => r.value,
  handler: Effect.fn("recordCashSettlement")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* recordCashSettlementForActor(
        { actor: { userId: user.id, accountId: account.id }, source: "app" },
        {
          splitParticipantId: input.splitParticipantId,
          amountPaise: input.amountPaise,
          note: input.note as string | null,
        },
      ).pipe(Effect.provideService(Actor, { userId: user.id, accountId: account.id }), ledgerEffectErrors);

    return result;
  }),
};

const deleteCashSettlementInput = Schema.Struct({
  settlementId: Schema.String,
});
export const deleteCashSettlementSpec: ActionSpec<
  typeof deleteCashSettlementInput.Type,
  typeof deleteCashSettlementInput.Encoded,
  Awaited<ReturnType<typeof deleteCashSettlementForActor>>,
  CurrentUser | Db,
  void
> = {
  input: deleteCashSettlementInput,
  revalidate: ["/reimbursements", "/transactions", "/"],
  revalidateWhen: (r) => r.revalidate,
  toData: () => undefined,
  handler: Effect.fn("deleteCashSettlement")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* fromLedger(() =>
      deleteCashSettlementForActor(
        { actor: { userId: user.id, accountId: account.id }, source: "app" },
        {
          settlementId: input.settlementId,
        },
      ),
    );

    return result;
  }),
};

const writeOffParticipantShareInput = Schema.Struct({
  splitParticipantId: Schema.String,
  // main tolerated an omitted note (the core normalizes it).
  note: Schema.optional(Schema.NullOr(Schema.String)),
});
export const writeOffParticipantShareSpec: ActionSpec<
  typeof writeOffParticipantShareInput.Type,
  typeof writeOffParticipantShareInput.Encoded,
  Awaited<ReturnType<typeof writeOffParticipantShareForActor>>,
  CurrentUser | Db,
  void
> = {
  input: writeOffParticipantShareInput,
  revalidate: ["/reimbursements", "/transactions", "/people", "/"],
  revalidateWhen: (r) => r.revalidate,
  toData: () => undefined,
  handler: Effect.fn("writeOffParticipantShare")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* fromLedger(() =>
      writeOffParticipantShareForActor(
        { actor: { userId: user.id, accountId: account.id }, source: "app" },
        {
          splitParticipantId: input.splitParticipantId,
          note: input.note as string | null,
        },
      ),
    );

    return result;
  }),
};

const undoWriteOffInput = Schema.Struct({ settlementId: Schema.String });
export const undoWriteOffSpec: ActionSpec<
  typeof undoWriteOffInput.Type,
  typeof undoWriteOffInput.Encoded,
  Awaited<ReturnType<typeof undoWriteOffForActor>>,
  CurrentUser | Db,
  void
> = {
  input: undoWriteOffInput,
  revalidate: ["/reimbursements", "/transactions", "/people", "/"],
  revalidateWhen: (r) => r.revalidate,
  toData: () => undefined,
  handler: Effect.fn("undoWriteOff")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* fromLedger(() =>
      undoWriteOffForActor(
        { actor: { userId: user.id, accountId: account.id }, source: "app" },
        {
          settlementId: input.settlementId,
        },
      ),
    );

    return result;
  }),
};
