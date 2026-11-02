import { Context, Effect, Exit, Runtime } from "effect";
// Type-only: keeps this module importable from `bun test` (src/db pulls in
// `server-only`, which throws outside Next).
import type { db as dbClient } from "@/db";

/** The signed-in user. Resolved from the session, never from client input. */
export class CurrentUser extends Context.Tag("money/CurrentUser")<
  CurrentUser,
  { readonly id: string; readonly email: string | null }
>() {}

export type Database = typeof dbClient;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class Db extends Context.Tag("money/Db")<Db, Database>() {}

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
export const transaction = <A, E, R>(
  body: (tx: Tx) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const runtime = yield* Effect.runtime<R>();
    const exit = yield* Effect.promise(() =>
      db
        .transaction(async (tx) => {
          const result = await Runtime.runPromiseExit(runtime)(body(tx));
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
