import "server-only";
import { Effect } from "effect";
import {
  assertAccountOwned,
  assertCategoryOwned,
  assertCounterpartyOwned,
  assertNetEventOwned,
  assertOwedExpenseOwned,
  assertPersonOwned,
  assertSettlementOwned,
  assertSplitParticipantOwned,
  assertTransactionOwned,
  assertTransactionsOwned,
} from "@/lib/auth/ownership";
import { ForbiddenError } from "@/lib/auth/forbidden";
import { Forbidden } from "./errors";
import { CurrentUser } from "./services";

/**
 * Ownership checks for Effect handlers. They take the user from
 * `CurrentUser`, so a handler can't pass the wrong (or a client-supplied) id.
 * Same SQL as src/lib/auth/ownership.ts — this only adapts the error.
 */
const guard =
  <Args extends unknown[], A>(
    assert: (userId: string, ...args: Args) => Promise<A>,
  ) =>
  (...args: Args): Effect.Effect<A, Forbidden, CurrentUser> =>
    Effect.flatMap(CurrentUser, (user) =>
      Effect.tryPromise({
        try: () => assert(user.id, ...args),
        catch: (err) => err,
      }).pipe(
        Effect.catch((err) =>
          err instanceof ForbiddenError
            ? Effect.fail(new Forbidden())
            : Effect.die(err),
        ),
      ),
    );

export const owns = {
  account: guard(assertAccountOwned),
  category: guard(assertCategoryOwned),
  counterparty: guard(assertCounterpartyOwned),
  netEvent: guard(assertNetEventOwned),
  owedExpense: guard(assertOwedExpenseOwned),
  person: guard(assertPersonOwned),
  settlement: guard(assertSettlementOwned),
  splitParticipant: guard(assertSplitParticipantOwned),
  /** Resolves to `{ accountId }` of the owned transaction. */
  transaction: guard(assertTransactionOwned),
  transactions: guard(assertTransactionsOwned),
};
