import { expect, test } from "bun:test";
import { Schema } from "effect";
import { sanitizedInput } from "./sanitized-input";

test("sanitized action fields preserve loose payloads and discard undeclared actor ids", () => {
  const decode = Schema.decodeUnknownSync(sanitizedInput({
    rows: Schema.optional(Schema.Unknown),
    offset: Schema.optional(Schema.Unknown),
  }));
  for (const value of [undefined, null, [], 42, true, "text"]) expect(decode(value)).toEqual({});
  const rows = [null, 42, { transactionId: "sample", categoryId: "sample-category" }];
  expect(decode({ rows, offset: "not a number", userId: "foreign", accountId: "foreign-account" }))
    .toEqual({ rows, offset: "not a number" });
});
