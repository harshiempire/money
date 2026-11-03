import "server-only";
import { Effect, Schema } from "effect";
import type { ActionSpec } from "@/lib/action/core";
import { CurrentUser, type Db } from "@/lib/action/services";
import { fromLedger } from "@/lib/action/ledger";
import { getOrCreateAccountForBank } from "@/db/money-account";
import {
  createOwedExpense as createOwedExpenseForActor,
  updateOwedExpense as updateOwedExpenseForActor,
  deleteOwedExpense as deleteOwedExpenseForActor,
} from "@/lib/ledger/owed-expenses";

const createOwedExpenseInput = Schema.Struct({
  personName: Schema.String,
  incurredDate: Schema.String,
  amountPaise: Schema.Number,
  description: Schema.String,
  categoryId: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.optional(Schema.NullOr(Schema.String)),
});
export const createOwedExpenseSpec: ActionSpec<
  typeof createOwedExpenseInput.Type,
  typeof createOwedExpenseInput.Encoded,
  Awaited<ReturnType<typeof createOwedExpenseForActor>>,
  CurrentUser | Db,
  NonNullable<Awaited<ReturnType<typeof createOwedExpenseForActor>>["value"]>
> = {
  input: createOwedExpenseInput,
  revalidate: ["/reimbursements", "/transactions", "/people", "/spend", "/"],
  revalidateWhen: (r) => r.revalidate,
  // The handler fails (as a logged defect) before this if the core returned no value.
  toData: (r) => r.value as NonNullable<typeof r.value>,
  handler: Effect.fn("createOwedExpense")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* fromLedger(() =>
      createOwedExpenseForActor(
        { actor: { userId: user.id, accountId: account.id }, source: "app" },
        {
          personName: input.personName,
          incurredDate: input.incurredDate,
          amountPaise: input.amountPaise,
          description: input.description,
          ...(input.categoryId !== undefined
            ? { categoryId: input.categoryId }
            : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
        },
      ),
    );

    if (result.value === undefined) {
      return yield* Effect.die(new Error("createOwedExpense: the ledger core returned no value"));
    }
    return result;
  }),
};

const updateOwedExpenseInput = Schema.Struct({
  id: Schema.String,
  personName: Schema.optional(Schema.String),
  incurredDate: Schema.optional(Schema.String),
  amountPaise: Schema.optional(Schema.Number),
  description: Schema.optional(Schema.String),
  categoryId: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.optional(Schema.NullOr(Schema.String)),
});
export const updateOwedExpenseSpec: ActionSpec<
  typeof updateOwedExpenseInput.Type,
  typeof updateOwedExpenseInput.Encoded,
  Awaited<ReturnType<typeof updateOwedExpenseForActor>>,
  CurrentUser | Db,
  void
> = {
  input: updateOwedExpenseInput,
  revalidate: ["/reimbursements", "/transactions", "/people", "/spend", "/"],
  revalidateWhen: (r) => r.revalidate,
  toData: () => undefined,
  handler: Effect.fn("updateOwedExpense")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* fromLedger(() =>
      updateOwedExpenseForActor(
        { actor: { userId: user.id, accountId: account.id }, source: "app" },
        {
          id: input.id,
          ...(input.personName !== undefined
            ? { personName: input.personName }
            : {}),
          ...(input.incurredDate !== undefined
            ? { incurredDate: input.incurredDate }
            : {}),
          ...(input.amountPaise !== undefined
            ? { amountPaise: input.amountPaise }
            : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.categoryId !== undefined
            ? { categoryId: input.categoryId }
            : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
        },
      ),
    );

    return result;
  }),
};

const deleteOwedExpenseInput = Schema.Struct({ id: Schema.String });
export const deleteOwedExpenseSpec: ActionSpec<
  typeof deleteOwedExpenseInput.Type,
  typeof deleteOwedExpenseInput.Encoded,
  Awaited<ReturnType<typeof deleteOwedExpenseForActor>>,
  CurrentUser | Db,
  void
> = {
  input: deleteOwedExpenseInput,
  revalidate: ["/reimbursements", "/transactions", "/people", "/spend", "/"],
  revalidateWhen: (r) => r.revalidate,
  toData: () => undefined,
  handler: Effect.fn("deleteOwedExpense")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    const result = yield* fromLedger(() =>
      deleteOwedExpenseForActor(
        { actor: { userId: user.id, accountId: account.id }, source: "app" },
        {
          id: input.id,
        },
      ),
    );

    return result;
  }),
};
