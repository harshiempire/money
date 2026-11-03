/**
 * Compile-time checks for ActionSpec (checked by `tsc`; never imported).
 * Each @ts-expect-error must stay an error: if one stops erroring, the type
 * protection it guards is gone and typecheck fails.
 */
import { Effect, Schema } from "effect";
import type { ActionSpec } from "./core";

const input = Schema.Struct({ id: Schema.String });
type In = typeof input.Type;
type Enc = typeof input.Encoded;
type Receipt = { revalidate: boolean; value: string };

// A result that isn't the declared Data needs toData…
// @ts-expect-error toData is required when Receipt is not assignable to string
export const missingProjection: ActionSpec<In, Enc, Receipt, never, string> = {
  input,
  handler: () => Effect.succeed({ revalidate: true, value: "x" }),
};

// …and with it, it typechecks.
export const projected: ActionSpec<In, Enc, Receipt, never, string> = {
  input,
  handler: () => Effect.succeed({ revalidate: true, value: "x" }),
  toData: (r) => r.value,
};

// When the result already is Data, toData stays optional.
export const plain: ActionSpec<In, Enc, { updated: number }, never> = {
  input,
  handler: () => Effect.succeed({ updated: 1 }),
};
