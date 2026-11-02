import { expect, test } from "bun:test";
import { Schema } from "effect";
import { ListTransactionsInput, PeriodInput } from "./schemas";
import { resolveMcpPeriod } from "./range";

for (const schema of [PeriodInput, ListTransactionsInput]) {
  test("ranges accept month or inclusive bounds or all time and reject mixed/invalid ranges", () => {
    for (const input of [{}, { month: "2026-10" }, { from: "2026-01-01" }, { to: "2026-12-31" },
      { from: "2024-02-29", to: "2024-02-29" }]) expect(Schema.is(schema)(input)).toBe(true);
    for (const input of [{ month: "2026-10", from: "2026-10-01" }, { month: "2026-10", to: "2026-10-31" },
      { from: "2026-02-29" }, { to: "2026-04-31" }, { from: "2026-12-31", to: "2026-01-01" },
      { month: "2026-13" }, { from: "2026-1-01" }]) expect(Schema.is(schema)(input)).toBe(false);
  });
}

test("MCP month bounds include the full calendar month; default is unbounded all time", () => {
  expect(resolveMcpPeriod({})).toEqual({ from: null, to: null, label: "All time", partial: false });
  expect(resolveMcpPeriod({ month: "2024-02" })).toMatchObject({ from: "2024-02-01", to: "2024-02-29" });
  expect(resolveMcpPeriod({ month: "2100-02" })).toMatchObject({ to: "2100-02-28" });
  expect(resolveMcpPeriod({ from: "2026-10-15" })).toMatchObject({ from: "2026-10-15", to: null });
});
