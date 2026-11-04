import { Context, Effect, Exit } from "effect";
import type { db as dbClient } from "@/db";

export class Actor extends Context.Service<Actor, { readonly userId: string; readonly accountId: string }>()("money/lib/ledger/Actor") {}

export type Database = typeof dbClient;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class Db extends Context.Service<Db, Database>()("money/lib/action/Db") {}

/**
 * Run a Drizzle query. A rejected promise is a defect (logged, generic message
 * to the client) — map expected DB failures explicitly with `Effect.tryPromise`.
 */
export const query = <A>(
  f: (db: Database) => Promise<A>,
): Effect.Effect<A, never, Db> =>
  Effect.flatMap(Db, (db) => Effect.promise(() => f(db)));

class Rollback {
  constructor(readonly exit: Exit.Exit<unknown, unknown>) {}
}

/**
 * `db.transaction` for Effect code. Any failure in `body` — a typed error like
 * `Invalid` as well as a defect — rolls the transaction back, and the original
 * error comes out the other side unchanged.
 */
export const transaction = Effect.fnUntraced(function* <A, E, R>(
  body: (tx: Tx) => Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E, R | Db> {
  const db = yield* Db;
  const services = yield* Effect.context<R>();
  const run = Effect.runPromiseExitWith(services);
  // The body runs as its own execution inside Drizzle's callback. Forward the
  // caller's abort signal so interrupting the caller (a timeout, a cancelled
  // request) interrupts the body too — an interrupted body fails, and a failed
  // body always rolls back.
  const exit: Exit.Exit<A, E> = yield* Effect.promise((signal) =>
    db
      .transaction(async (tx) => {
        const result = await run(body(tx), { signal });
        // Throwing is the only way to make Drizzle roll back.
        if (Exit.isFailure(result)) throw new Rollback(result);
        return result;
      })
      .catch((err: unknown) => {
        if (err instanceof Rollback) return err.exit as Exit.Exit<A, E>;
        throw err;
      }),
  );
  return yield* exit;
});
