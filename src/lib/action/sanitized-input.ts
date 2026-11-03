import { Schema, SchemaGetter } from "effect";

/**
 * For actions that already read fields from any input with optional access.
 * Preserve those permissive boundaries (including null, arrays and primitives),
 * then decode only the declared fields. Individual fields remain Unknown where
 * the existing handler owns trimming, filtering and user-facing validation.
 */
export const sanitizedInput = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Unknown.pipe(
    Schema.decodeTo(Schema.Struct(fields), {
      decode: SchemaGetter.transform((input) => ({ ...Object(input) })),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  );
