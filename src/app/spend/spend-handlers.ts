import "server-only";
import { Effect, Schema } from "effect";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { categoryTransactions, type CategoryTransactionRow } from "@/domain/spend/net";
import type { ActionSpec } from "@/lib/action/core";
import { CurrentUser, type Db } from "@/lib/action/services";

/** Read handler behind ./actions.ts: one category's transactions for a period. */

const Input = Schema.Struct({
  categoryId: Schema.NullOr(Schema.String),
  from: Schema.NullOr(Schema.String),
  to: Schema.NullOr(Schema.String),
});

export const getCategoryTransactionsSpec: ActionSpec<
  typeof Input.Type,
  typeof Input.Encoded,
  CategoryTransactionRow[],
  CurrentUser | Db
> = {
  input: Input,
  handler: Effect.fn("getCategoryTransactions")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
    return yield* Effect.promise(() =>
      categoryTransactions(account.id, input.from, input.to, input.categoryId, user.id),
    );
  }),
};
