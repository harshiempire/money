import { describe, expect, test } from "bun:test";
import { isUseServerFile, unwrappedExports } from "./server-action-exports";

describe("isUseServerFile", () => {
  test("plain directive", () => expect(isUseServerFile(`"use server";\nexport const a = 1;`)).toBe(true));
  test("single quotes, no semicolon", () => expect(isUseServerFile(`'use server'\nexport const a = 1`)).toBe(true));
  test("comments before the directive", () =>
    expect(isUseServerFile(`// header\n/* block\n comment */\n"use server";\n`)).toBe(true));
  test("after another directive", () => expect(isUseServerFile(`"use strict";\n"use server";\n`)).toBe(true));
  test("not a directive once code starts", () =>
    expect(isUseServerFile(`import x from "y";\n"use server";\n`)).toBe(false));
  test("use client is not use server", () => expect(isUseServerFile(`"use client";\n`)).toBe(false));
});

describe("unwrappedExports", () => {
  const ok = `"use server";
import { defineAction, definePublicAction, asFormAction } from "@/lib/action/define-action";
export const a = defineAction("a", spec);
export const b =
  defineAction("b", spec);
export const c = asFormAction(definePublicAction("c", spec));
export const d: Action = defineAction("d", spec);
export const e: (input: { id: string }) => Promise<Result<void>> = defineAction("e", spec);
const f = defineAction("f", spec);
export { f, f as g };
export type T = string;
export interface U { x: number }
export type { V } from "./v";
`;
  test("accepts every wrapped form, ignores type exports", () => expect(unwrappedExports(ok)).toEqual([]));

  test("flags a bare async function", () =>
    expect(unwrappedExports(`"use server";\nexport async function bare() {}`)).toEqual(["bare"]));
  test("flags a plain function", () =>
    expect(unwrappedExports(`"use server";\nexport function plain() {}`)).toEqual(["plain"]));
  test("flags an unwrapped arrow const", () =>
    expect(unwrappedExports(`"use server";\nexport const arrow = async () => {};`)).toEqual(["arrow"]));
  test("flags a typed unwrapped const (type contains =>)", () =>
    expect(unwrappedExports(`"use server";\nexport const typed: (i: number) => Promise<void> = async () => {};`)).toEqual(["typed"]));
  test("flags a value that merely mentions a wrapper later", () =>
    expect(unwrappedExports(`"use server";\nexport const x = make(defineAction("x", spec));`)).toEqual(["x"]));
  test("flags let", () =>
    expect(unwrappedExports(`"use server";\nexport let l = defineAction("l", spec);`)).toEqual(["l"]));
  test("flags a named export of an unwrapped local", () =>
    expect(unwrappedExports(`"use server";\nasync function hidden() {}\nexport { hidden };`)).toEqual(["hidden"]));
  test("flags an alias of an unwrapped local", () =>
    expect(unwrappedExports(`"use server";\nconst raw = async () => {};\nexport { raw as nice };`)).toEqual(["nice"]));
  test("flags default exports", () =>
    expect(unwrappedExports(`"use server";\nexport default async function () {}`)).toEqual(["default"]));
  test("flags re-exports from another module (can't be verified here)", () =>
    expect(unwrappedExports(`"use server";\nexport { thing } from "./elsewhere";`)).toEqual(["thing"]));
});
