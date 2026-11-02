import "server-only";
import { Effect, Schema } from "effect";
import type { ActionSpec } from "@/lib/action/core";
import { CurrentUser, type Db } from "@/lib/action/services";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { categoryTransactions } from "@/domain/spend/net";

const getCategoryTransactionsInput = Schema.Struct({
  // main treated omitted filters as absent; forwarded as-is below.
  categoryId: Schema.optional(Schema.NullOr(Schema.String)),
  from: Schema.optional(Schema.NullOr(Schema.String)),
  to: Schema.optional(Schema.NullOr(Schema.String)),
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
        // Same runtime values as main (an omitted filter arrives as undefined).
        input.from as string | null,
        input.to as string | null,
        input.categoryId as string | null,
        user.id,
      ),
    );
  }),
};
