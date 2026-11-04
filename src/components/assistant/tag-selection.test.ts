import { expect, test } from "bun:test";
import { appendPreselectedRows } from "./tag-selection";

const row = (txnId: string, sure = true) => ({ txnId, sure });
const preselected = (r: ReturnType<typeof row>) => r.sure;

test("streamed preselected rows join selection without restoring deselected rows", () => {
  const seen = new Set(["old", "manual"]);
  const selected = new Set(["manual"]);
  const next = appendPreselectedRows([row("old"), row("manual", false), row("new"), row("unsure", false)], seen, selected, preselected);
  expect([...next.selected]).toEqual(["manual", "new"]);
  expect([...next.seen]).toEqual(["old", "manual", "new", "unsure"]);
  expect([...seen]).toEqual(["old", "manual"]);
  expect([...selected]).toEqual(["manual"]);
});

test("rearriving rows and changed suggestions never override user selection", () => {
  const seen = new Set(["removed", "unsure"]);
  const selected = new Set<string>();
  const next = appendPreselectedRows([row("removed"), row("unsure")], seen, selected, preselected);
  expect(next.seen).toBe(seen);
  expect(next.selected).toBe(selected);
});

test("new unsure rows are remembered even though none is selected", () => {
  const selected = new Set<string>();
  const next = appendPreselectedRows([row("unsure", false)], new Set(), selected, preselected);
  expect(next.selected).toBe(selected);
  expect(next.seen.has("unsure")).toBe(true);
  expect(appendPreselectedRows([row("unsure")], next.seen, next.selected, preselected).selected.size).toBe(0);
});

test("empty arrivals preserve selection and seen identities", () => {
  const seen = new Set(["a"]);
  const selected = new Set(["a"]);
  expect(appendPreselectedRows([], seen, selected, preselected)).toEqual({ seen, selected });
});
