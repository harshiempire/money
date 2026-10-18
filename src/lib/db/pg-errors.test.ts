import { expect, test } from "bun:test";
import { isMissingTable } from "./pg-errors";

test("a missing table is Postgres 42P01 on the error or its cause", () => {
  expect(isMissingTable({ code: "42P01" })).toBe(true);
  expect(isMissingTable({ cause: { code: "42P01" } })).toBe(true);
  expect(isMissingTable({ code: "23505" })).toBe(false);
  expect(isMissingTable(new Error("nope"))).toBe(false);
});
