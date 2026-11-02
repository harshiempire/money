import "server-only";
import { Effect, Schema } from "effect";
import type { ActionSpec } from "@/lib/action/core";
import { CurrentUser, type Db } from "@/lib/action/services";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { categoryTransactions } from "@/domain/spend/net";

const getCategoryTransactionsInput = Schema.Struct({
  categoryId: Schema.NullOr(Schema.String),
  from: Schema.NullOr(Schema.String),
  to: Schema.NullOr(Schema.String),
});
export const getCategoryTransactionsSpec: ActionSpec<
  typeof getCategoryTransactionsInput.Type,
  typeof getCategoryTransactionsInput.Encoded,
  Awaited<ReturnType<typeof categoryTransactions>>,
  CurrentUser | Db
> = {
  input: getCategoryTransactionsInput,
  handler: Effect.fn("getCategoryTransactions")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() =>
      getOrCreateAccountForBank(user.id, "bob"),
    );
    return yield* Effect.promise(() =>
      categoryTransactions(
        account.id,
        input.from,
        input.to,
        input.categoryId,
        user.id,
      ),
    );
  }),
};
