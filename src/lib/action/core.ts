import {
  Cause,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  SchemaIssue,
} from "effect";
import { Invalid, toFailure, type ActionError } from "./errors";
import { GENERIC_ERROR_MESSAGE, type ActionResult } from "./result";

/**
 * Framework-free core of `defineAction`, kept separate so it runs under
 * `bun test` without Next or a database.
 */

interface ActionSpecBase<I, IEncoded, A, R> {
  /** Every argument from the browser is decoded with this before use. */
  readonly input: Schema.Codec<I, IEncoded>;
  readonly handler: (input: I) => Effect.Effect<A, ActionError, R>;
  /**
   * Paths to revalidate — only after the handler succeeds. A function picks
   * them from the handler's result (e.g. different paths when nothing changed).
   */
  readonly revalidate?: readonly string[] | ((data: A) => readonly string[]);
  /**
   * Optional: revalidate only when this returns true for the handler's result
   * (e.g. a ledger core's `result.revalidate` — false when nothing changed).
   */
  readonly revalidateWhen?: (data: A) => boolean;
}

/**
 * `toData` turns the handler's result (e.g. a ledger receipt that
 * `revalidateWhen` reads) into what the client receives. It is REQUIRED when
 * the result isn't already the declared `Data`, so a spec can't hand the
 * client a value of the wrong type.
 *
 * It runs after the write has happened: keep it a pure, total selector
 * (`(r) => r.value`, `() => undefined`). Anything that can fail belongs in the
 * handler, before the write.
 */
export type ActionSpec<I, IEncoded, A, R, Data = A> = ActionSpecBase<I, IEncoded, A, R> &
  ([A] extends [Data]
    ? { readonly toData?: (data: A) => Data }
    : { readonly toData: (data: A) => Data });

export interface RunOptions<R, A = unknown> {
  /** Used in server logs, e.g. "createSplit". */
  readonly name: string;
  readonly layer: Layer.Layer<R, ActionError>;
  readonly onSuccess?: (data: A) => void;
  /**
   * Called with every defect before it's swallowed. Next's `redirect()` /
   * `notFound()` work by throwing; the Next wrapper passes `unstable_rethrow`
   * here so those keep working.
   */
  readonly rethrow?: (defect: unknown) => void;
  readonly log?: (message: string) => void;
}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/** Decode untrusted input; a mismatch becomes `Invalid` naming the field. */
export const decodeInput = <I, IEncoded>(
  schema: Schema.Codec<I, IEncoded>,
  raw: unknown,
): Effect.Effect<I, Invalid> =>
  Schema.decodeUnknownEffect(schema, {
    errors: "first",
    onExcessProperty: "ignore",
  })(raw).pipe(
    Effect.mapError((err) => {
      const [issue] = formatIssue(err.issue).issues;
      const field = issue?.path?.map(String).join(".");
      const message = issue?.message ?? "The request was malformed.";
      return new Invalid(field ? { message, field } : { message });
    }),
  );

export async function runAction<I, IEncoded, A, R, Data = A>(
  spec: ActionSpec<I, IEncoded, A, R, Data>,
  raw: unknown,
  options: RunOptions<R, A>,
): Promise<ActionResult<Data>> {
  // Deferred: Schema decoding parses eagerly when called, and it must not run
  // until the layer (the session check) has been built — anonymous requests
  // shouldn't get the server to parse their payload.
  const program = Effect.suspend(() => decodeInput(spec.input, raw)).pipe(
    Effect.flatMap(spec.handler),
    Effect.provide(options.layer),
  );

  const exit = await Effect.runPromiseExit(program);

  if (Exit.isSuccess(exit)) {
    // The write has committed: a failure while revalidating must not turn the
    // result into a failure (the user would retry a write that succeeded).
    try {
      options.onSuccess?.(exit.value);
    } catch (err) {
      options.rethrow?.(err);
      (options.log ?? console.error)(
        `[action:${options.name}] succeeded, but revalidation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Without toData, the ActionSpec type guarantees the result already is Data.
    if (!spec.toData) return { ok: true, data: exit.value as unknown as Data };
    try {
      return { ok: true, data: spec.toData(exit.value) };
    } catch (err) {
      (options.log ?? console.error)(
        `[action:${options.name}] the write succeeded, but building the response failed (toData must be a pure selector): ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, code: "INTERNAL", message: GENERIC_ERROR_MESSAGE };
    }
  }

  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) return toFailure(failure.value);

  // A defect: a bug, a DB outage, or a Next control-flow throw.
  for (const reason of exit.cause.reasons.filter(Cause.isDieReason)) {
    options.rethrow?.(reason.defect);
  }
  (options.log ?? console.error)(
    `[action:${options.name}] ${Cause.pretty(exit.cause)}`,
  );
  return { ok: false, code: "INTERNAL", message: GENERIC_ERROR_MESSAGE };
}
