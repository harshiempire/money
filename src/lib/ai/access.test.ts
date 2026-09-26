import { expect, test } from "bun:test";
import { isAiAllowed } from "./access";

test("isAiAllowed is off unless the user is listed", () => {
  expect(isAiAllowed("u1", undefined)).toBe(false);
  expect(isAiAllowed("u1", "")).toBe(false);
  expect(isAiAllowed("u1", "u2")).toBe(false);
  expect(isAiAllowed("u1", " u2 , u1 ")).toBe(true);
  expect(isAiAllowed("", ",")).toBe(false);
});
