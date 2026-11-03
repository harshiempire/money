import { Effect } from "effect";
import { Conflict, Invalid } from "./errors";

/** The `{ ok, message }` shape the pure validators in src/lib/** return. */
export type Validation = { ok: true } | { ok: false; message: string };

/** Lift an existing pure validator result into an `Invalid` failure. */
export const check = (
  v: Validation,
  field?: string,
): Effect.Effect<void, Invalid> =>
  v.ok
    ? Effect.void
    : Effect.fail(
        field === undefined
          ? new Invalid({ message: v.message })
          : new Invalid({ message: v.message, field }),
      );

/** Same as `check`, for rules about current data rather than the request. */
export const checkState = (v: Validation): Effect.Effect<void, Conflict> =>
  v.ok ? Effect.void : Effect.fail(new Conflict({ message: v.message }));

export const invalid = (message: string, field?: string) =>
  Effect.fail(
    field === undefined ? new Invalid({ message }) : new Invalid({ message, field }),
  );

export const conflict = (message: string) =>
  Effect.fail(new Conflict({ message }));
