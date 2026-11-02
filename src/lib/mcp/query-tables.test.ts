import { expect, test } from "bun:test";
import { buildMcpQueryTables, describeMcpTable, formatMcpQueryResult, MCP_QUERY_TABLES } from "./query-tables";
import { fixtureView, readFixture } from "./read-fixtures";
import { createQuerySandbox } from "@/lib/assistant/query-sandbox";
import { QUERY_TABLES } from "@/lib/assistant/query-tables";

test("MCP tables contain unredacted text, stable cross-tool refs, all model entities, and no database IDs", () => {
  const view = fixtureView();
  const tables = buildMcpQueryTables(view, [{ name: "Food@home 123456", kind: "spend" }], ["Pay ravi@bank 9876543210"]);
  expect(tables.map((t) => t.name)).toEqual(["transactions", "payees", "people", "splits", "shares", "settlements", "net_events", "owed", "categories", "standing_notes"]);
  expect(tables.every((t) => t.rows.every((r) => r.length === t.columns.length))).toBe(true);
  const json = JSON.stringify(tables);
  const model = readFixture();
  for (const rows of [model.transactions, model.splits, model.shares, model.owed, model.settlements, model.netEvents]) {
    for (const row of rows) expect(json).not.toContain(row.id);
  }
  expect(json).toContain("UPI 12345678 rooster@bank"); expect(json).toContain("Pay ravi@bank 9876543210");
  expect(tables.find((t) => t.name === "shares")!.rows[0][0]).toBe(view.shares[0].ref);
  expect(tables.find((t) => t.name === "transactions")!.rows[0][0]).toBe(view.transactions[0].ref);
  expect(tables.find((t) => t.name === "transactions")!.rows[0][2]).toBe(56700);
  for (const table of MCP_QUERY_TABLES) {
    expect(describeMcpTable(table.name.toUpperCase()).columns.every((c) => c.about.length > 5)).toBe(true);
  }
  expect(() => describeMcpTable("auth")).toThrow("Unknown table");
  expect(QUERY_TABLES.map((t) => t.name)).toEqual(["txn", "category", "person", "split", "split_participant", "owed_expense"]);
});

test("MCP money conversion is exact, preserves refs and count results, and marks truncation", () => {
  expect(formatMcpQueryResult({ columns: ["ref", "sum(amount_paise)", "count(amount_paise)", "left_paise", "difference_paise"], rows: [["txn_a", 56701, 3, 0, -101]], truncated: false })).toEqual({
    columns: ["ref", "sum(amount_paise)", "count(amount_paise)", "left_paise", "difference_paise"], rows: [["txn_a", "567.01", 3, "0.00", "-1.01"]], row_count: 1, truncated: false,
  });
  expect(formatMcpQueryResult({ columns: ["avg_paise"], rows: [[1.5]], truncated: false }).rows).toEqual([["0.02"]]);
  expect(() => formatMcpQueryResult({ columns: ["total_paise"], rows: [[Number.MAX_SAFE_INTEGER + 1]], truncated: false })).toThrow("exact paise range");
  const large = formatMcpQueryResult({ columns: ["text"], rows: Array.from({ length: 100 }, () => ["a".repeat(200)]), truncated: false });
  expect(large.truncated).toBe(true); expect(large.row_count).toBeLessThan(100);
});

test("MCP tables run in the shared locked-down engine, join by reusable refs and refuse writes/schema access", async () => {
  const view = fixtureView();
  const sandbox = createQuerySandbox(async () => buildMcpQueryTables(view, [], []));
  try {
    const result = await sandbox.run("select s.ref, t.ref as txn_ref, s.left_paise from shares s join transactions t on t.ref = s.txn_ref where s.person = 'Kiran' order by t.date");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(formatMcpQueryResult(result).rows).toEqual([[view.shares[1].ref, view.shares[1].txn_ref, "2.00"], [view.shares[0].ref, view.shares[0].txn_ref, "194.00"]]);
    for (const sql of ["delete from shares", "select * from sqlite_schema", "select * from user", "select * from txn", "select 1; select 2"]) {
      expect((await sandbox.run(sql)).ok).toBe(false);
    }
  } finally { sandbox.close(); }
});
