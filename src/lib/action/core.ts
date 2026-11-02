import { Cause, Effect, Exit, Layer, Option, Schema, SchemaIssue } from "effect";
import { Invalid, toFailure, type ActionError } from "./errors";
import { GENERIC_ERROR_MESSAGE, type ActionResult } from "./result";

/**
 * Framework-free core of `defineAction`, kept separate so it runs under
 * `bun test` without Next or a database.
 */

export interface ActionSpec<I, IEncoded, A, R> {
  /** Every argument from the browser is decoded with this before use. */
  readonly input: Schema.Codec<I, IEncoded>;
  readonly handler: (input: I) => Effect.Effect<A, ActionError, R>;
  /** Paths to revalidate — only after the handler succeeds. */
  readonly revalidate?: readonly string[];
}

export interface RunOptions<R> {
  /** Used in server logs, e.g. "createSplit". */
  readonly name: string;
  readonly layer: Layer.Layer<R, ActionError>;
  readonly onSuccess?: () => void;
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

export async function runAction<I, IEncoded, A, R>(
  spec: ActionSpec<I, IEncoded, A, R>,
  raw: unknown,
  options: RunOptions<R>,
): Promise<ActionResult<A>> {
  const program = decodeInput(spec.input, raw).pipe(
    Effect.flatMap(spec.handler),
    Effect.provide(options.layer),
  );

  const exit = await Effect.runPromiseExit(program);

  if (Exit.isSuccess(exit)) {
    options.onSuccess?.();
    return { ok: true, data: exit.value };
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
