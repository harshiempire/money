import "server-only";
import { Effect, Layer } from "effect";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { db } from "@/db";
import { sessionUser } from "@/lib/auth/require-current-user";
import { runAction, type ActionSpec } from "./core";
import { Unauthenticated } from "./errors";
import type { ActionResult } from "./result";
import { CurrentUser, Db } from "./services";

/**
 * The only way to write a server action in this app:
 *
 *   "use server";
 *   export const createSplit = defineAction("createSplit", {
 *     input: CreateSplitInput,            // Effect Schema; decodes the raw arg
 *     revalidate: ["/transactions", "/"],  // only on success
 *     handler: (input) => Effect.gen(function* () {
 *       const { accountId } = yield* owns.transaction(input.transactionId);
 *       ...
 *     }),
 *   });
 *
 * What it guarantees:
 * - The session is checked before the handler runs; no session → UNAUTHENTICATED.
 * - `CurrentUser` comes from the session. The input schema never carries a
 *   userId/accountId for authorization (AGENTS.md security checklist).
 * - Expected failures return as `ActionResult` values, so their messages reach
 *   the browser in production. Defects are logged and returned as a generic
 *   message — internals never leak.
 * - `redirect()` / `notFound()` thrown inside a handler still work.
 */
export function defineAction<I, IEncoded, A>(
  name: string,
  spec: ActionSpec<I, IEncoded, A, CurrentUser | Db>,
): (input: IEncoded) => Promise<ActionResult<A>> {
  return (raw) =>
    runAction(spec, raw, {
      name,
      layer: Layer.merge(CurrentUserLive, DbLive),
      rethrow: unstable_rethrow,
      onSuccess: () => spec.revalidate?.forEach((p) => revalidatePath(p)),
    });
}

/**
 * For the few actions that run without a session (registration). The handler
 * cannot ask for `CurrentUser` — the type won't allow it.
 */
export function definePublicAction<I, IEncoded, A>(
  name: string,
  spec: ActionSpec<I, IEncoded, A, Db>,
): (input: IEncoded) => Promise<ActionResult<A>> {
  return (raw) =>
    runAction(spec, raw, {
      name,
      layer: DbLive,
      rethrow: unstable_rethrow,
      onSuccess: () => spec.revalidate?.forEach((p) => revalidatePath(p)),
    });
}

const CurrentUserLive = Layer.effect(
  CurrentUser,
  Effect.promise(sessionUser).pipe(
    Effect.flatMap((user) =>
      user ? Effect.succeed(user) : Effect.fail(new Unauthenticated()),
    ),
  ),
);

const DbLive = Layer.succeed(Db, db);
