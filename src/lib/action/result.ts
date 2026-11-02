/**
 * What every server action returns to the browser.
 *
 * Expected failures (bad input, not yours, conflicting state) come back as
 * values. Next.js replaces the message of anything *thrown* from a server
 * action with an opaque digest in production, so throwing loses the text the
 * user needs to see.
 *
 * Client-safe: no Effect, no server imports.
 */
export type ActionErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "INTERNAL";

export type ActionFailure = {
  ok: false;
  code: ActionErrorCode;
  message: string;
  /** Dotted path of the input field the error belongs to, when known. */
  field?: string;
};

export type ActionResult<T> = { ok: true; data: T } | ActionFailure;

export const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

/** State shape for forms driven by React's useActionState (see asFormAction). */
export type FormState = { error?: string; field?: string };

/**
 * For callers that would rather throw on failure (e.g. inside a TanStack
 * Query `queryFn`). The thrown error is created in the browser, so its
 * message survives.
 */
export class ActionError extends Error {
  readonly code: ActionErrorCode;
  readonly field?: string;
  constructor(failure: ActionFailure) {
    super(failure.message);
    this.name = "ActionError";
    this.code = failure.code;
    this.field = failure.field;
  }
}

/**
 * Await an action call and turn a network failure (or anything else that
 * throws in the browser) into an INTERNAL result, so callers handle one shape.
 */
export async function callAction<T>(
  call: () => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  try {
    return await call();
  } catch (err) {
    console.error("[action]", err);
    return { ok: false, code: "INTERNAL", message: GENERIC_ERROR_MESSAGE };
  }
}

export function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) return result.data;
  throw new ActionError(result);
}
