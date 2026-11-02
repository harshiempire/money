import { describe, expect, test } from "bun:test";
import { Effect, Layer, Result, Schema } from "effect";
import { runAction, type ActionSpec } from "./core";
import { Forbidden, Invalid, Unauthenticated, Unavailable } from "./errors";
import { CurrentUser, Db, transaction, type Database } from "./services";
import { check } from "./validation";
import { GENERIC_ERROR_MESSAGE } from "./result";

const USER = { id: "u-1", email: "a@b.c" };
const signedIn = Layer.succeed(CurrentUser, USER);
const signedOut = Layer.effectContext(Effect.fail(new Unauthenticated()));

const Input = Schema.Struct({
  transactionId: Schema.String,
  amountPaise: Schema.Int,
});

function spec<A>(
  handler: ActionSpec<typeof Input.Type, typeof Input.Encoded, A, CurrentUser>["handler"],
): ActionSpec<typeof Input.Type, typeof Input.Encoded, A, CurrentUser> {
  return { input: Input, handler };
}

const quiet = () => {};
const good = { transactionId: "t-1", amountPaise: 500 };

describe("runAction", () => {
  test("returns data and runs onSuccess", async () => {
    let revalidated = false;
    const result = await runAction(
      spec(() => Effect.map(CurrentUser, (u) => `${u.id}:ok`)),
      good,
      { name: "t", layer: signedIn, onSuccess: () => (revalidated = true) },
    );
    expect(result).toEqual({ ok: true, data: "u-1:ok" });
    expect(revalidated).toBe(true);
  });

  test("onSuccess receives the handler's result (for revalidateWhen)", async () => {
    let seen: unknown;
    await runAction(spec(() => Effect.succeed({ revalidate: false })), good, {
      name: "t",
      layer: signedIn,
      onSuccess: (data) => (seen = data),
    });
    expect(seen).toEqual({ revalidate: false });
  });

  test("no session → UNAUTHENTICATED; handler and onSuccess never run", async () => {
    let ran = false;
    let revalidated = false;
    const result = await runAction(
      spec(() => Effect.sync(() => (ran = true))),
      good,
      { name: "t", layer: signedOut, onSuccess: () => (revalidated = true) },
    );
    expect(result).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
    expect(ran).toBe(false);
    expect(revalidated).toBe(false);
  });

  test("no session wins over bad input (anonymous callers learn nothing)", async () => {
    const result = await runAction(spec(() => Effect.void), { nope: 1 }, {
      name: "t",
      layer: signedOut,
    });
    expect(result).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
  });

  test("malformed input → INVALID naming the field; handler never runs", async () => {
    let ran = false;
    const result = await runAction(
      spec(() => Effect.sync(() => (ran = true))),
      { transactionId: "t-1", amountPaise: 12.5 },
      { name: "t", layer: signedIn },
    );
    expect(result).toMatchObject({ ok: false, code: "INVALID", field: "amountPaise" });
    expect(ran).toBe(false);
  });

  test("excess input properties are ignored, not passed through", async () => {
    const result = await runAction(
      spec((input) => Effect.succeed(Object.keys(input).sort())),
      { ...good, userId: "someone-else" },
      { name: "t", layer: signedIn },
    );
    expect(result).toEqual({ ok: true, data: ["amountPaise", "transactionId"] });
  });

  test("a validator failure keeps its message (the bug this fixes)", async () => {
    const result = await runAction(
      spec(() =>
        check({ ok: false, message: "Only a payment you made can be split." }),
      ),
      good,
      { name: "t", layer: signedIn },
    );
    expect(result).toEqual({
      ok: false,
      code: "INVALID",
      message: "Only a payment you made can be split.",
    });
  });

  test("Invalid with a field is reported against that field", async () => {
    const result = await runAction(
      spec(() => Effect.fail(new Invalid({ message: "Too much", field: "allocations.1" }))),
      good,
      { name: "t", layer: signedIn },
    );
    expect(result).toEqual({
      ok: false,
      code: "INVALID",
      message: "Too much",
      field: "allocations.1",
    });
  });

  test("Forbidden gives one generic answer", async () => {
    const result = await runAction(spec(() => Effect.fail(new Forbidden())), good, {
      name: "t",
      layer: signedIn,
    });
    expect(result).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "You don't have access to that.",
    });
  });

  test("Unavailable keeps its retry message", async () => {
    const result = await runAction(
      spec(() => Effect.fail(new Unavailable({ message: "Database connection timed out. Try again." }))),
      good,
      { name: "t", layer: signedIn },
    );
    expect(result).toEqual({
      ok: false,
      code: "UNAVAILABLE",
      message: "Database connection timed out. Try again.",
    });
  });

  test("a defect is logged and hidden; onSuccess doesn't run", async () => {
    const logs: string[] = [];
    let revalidated = false;
    const result = await runAction(
      spec(() => Effect.die(new Error("connection string postgres://secret"))),
      good,
      {
        name: "createSplit",
        layer: signedIn,
        log: (m) => logs.push(m),
        onSuccess: () => (revalidated = true),
      },
    );
    expect(result).toEqual({ ok: false, code: "INTERNAL", message: GENERIC_ERROR_MESSAGE });
    expect(logs[0]).toContain("[action:createSplit]");
    expect(logs[0]).toContain("postgres://secret");
    expect(revalidated).toBe(false);
  });

  test("rethrow can re-raise control-flow defects (redirect/notFound)", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;/login" });
    await expect(
      runAction(spec(() => Effect.die(redirect)), good, {
        name: "t",
        layer: signedIn,
        log: quiet,
        rethrow: (d) => {
          if ((d as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw d;
        },
      }),
    ).rejects.toBe(redirect);
  });
});

describe("transaction", () => {
  function fakeDb() {
    const state = { committed: 0, rolledBack: 0 };
    const db = {
      transaction: async (f: (tx: unknown) => Promise<unknown>) => {
        try {
          const r = await f({ fake: "tx" });
          state.committed++;
          return r;
        } catch (e) {
          state.rolledBack++;
          throw e;
        }
      },
    } as unknown as Database;
    return { state, layer: Layer.succeed(Db, db) };
  }

  test("commits and returns the body's value", async () => {
    const { state, layer } = fakeDb();
    const value = await Effect.runPromise(
      transaction(() => Effect.succeed(42)).pipe(Effect.provide(layer)),
    );
    expect(value).toBe(42);
    expect(state).toEqual({ committed: 1, rolledBack: 0 });
  });

  test("a typed failure rolls back and comes out unchanged", async () => {
    const { state, layer } = fakeDb();
    const error = new Invalid({ message: "A person name is required." });
    const result = await Effect.runPromise(
      transaction(() => Effect.fail(error)).pipe(Effect.result, Effect.provide(layer)),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(Result.isFailure(result) && result.failure).toBe(error);
    expect(state).toEqual({ committed: 0, rolledBack: 1 });
  });

  test("a defect rolls back and stays a defect", async () => {
    const { state, layer } = fakeDb();
    const exit = await Effect.runPromiseExit(
      transaction(() => Effect.die("boom")).pipe(Effect.provide(layer)),
    );
    expect(exit._tag).toBe("Failure");
    expect(state).toEqual({ committed: 0, rolledBack: 1 });
  });

  test("the body can use services from the surrounding context", async () => {
    const { layer } = fakeDb();
    const id = await Effect.runPromise(
      transaction(() => Effect.map(CurrentUser, (u) => u.id)).pipe(
        Effect.provide(Layer.merge(layer, signedIn)),
      ),
    );
    expect(id).toBe("u-1");
  });
});
