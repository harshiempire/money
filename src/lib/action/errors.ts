import { Schema } from "effect";
import type { ActionFailure } from "./result";

/** No signed-in user. */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  {},
) {}

/**
 * The record isn't the caller's — or doesn't exist. Deliberately the same
 * answer for both, so ids can't be probed.
 */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

/** The request itself is wrong: bad amounts, missing fields, broken rules. */
export class Invalid extends Schema.TaggedError<Invalid>()("Invalid", {
  message: Schema.String,
  /** Dotted path of the offending input field, when known. */
  field: Schema.optional(Schema.String),
}) {}

/** The request is well-formed but the current data won't allow it. */
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String,
}) {}

export type ActionError =
  | Unauthenticated
  | Forbidden
  | NotFound
  | Invalid
  | Conflict;

export function toFailure(error: ActionError): ActionFailure {
  switch (error._tag) {
    case "Unauthenticated":
      return {
        ok: false,
        code: "UNAUTHENTICATED",
        message: "Your session has ended. Sign in again.",
      };
    case "Forbidden":
      return {
        ok: false,
        code: "FORBIDDEN",
        message: "You don't have access to that.",
      };
    case "NotFound":
      return { ok: false, code: "NOT_FOUND", message: error.message };
    case "Invalid":
      return error.field === undefined
        ? { ok: false, code: "INVALID", message: error.message }
        : { ok: false, code: "INVALID", message: error.message, field: error.field };
    case "Conflict":
      return { ok: false, code: "CONFLICT", message: error.message };
  }
}
