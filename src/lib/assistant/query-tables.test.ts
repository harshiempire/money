import { describe, expect, test } from "bun:test";
import {
  QUERY_TABLES,
  buildQueryTables,
  describeTable,
  formatQueryResult,
  isMoneyColumn,
  queryBrief,
  type QueryData,
} from "./query-tables";

const data: QueryData = {
  txns: [
    { id: "id-a", date: "2026-08-06", paise: 224700, direction: "paid", payee: "Etsi", note: "dinner", category: "Food", channel: "upi", isTransfer: false, netSettled: false },
    { id: "id-b", date: "2026-08-09", paise: 1000000, direction: "paid", payee: "Own savings", note: null, category: null, channel: "imps", isTransfer: true, netSettled: true },
  ],
  categories: [{ name: "Food", kind: "spend" }],
  people: ["Nitin"],
  splits: [{ txnId: "id-a", totalPaise: 224700, yourSharePaise: 58400 }],
  participants: [{ txnId: "id-a", person: "Nitin", expectedPaise: 107900, settledPaise: 120000 }],
  owed: [{ person: "Nitin", date: "2026-09-02", paise: 30000, what: "Movie", settledPaise: 10000 }],
};

describe("query tables", () => {
  const refs = new Map<string, string>();
  const tables = buildQueryTables(data, (id) => refs.get(id) ?? (refs.set(id, `T${refs.size + 1}`), refs.get(id)!));
  const table = (name: string) => tables.find((t) => t.name === name)!;

  test("every row matches its table's columns", () => {
    for (const spec of QUERY_TABLES) {
      const t = table(spec.name);
      expect(t.columns.map((c) => c.name)).toEqual(spec.columns.map((c) => c.name));
      for (const row of t.rows) expect(row).toHaveLength(spec.columns.length);
    }
  });

  test("transactions are known by refs, never ids", () => {
    expect(table("txn").rows[0]).toEqual(["T1", "2026-08-06", 224700, "paid", "Etsi", "dinner", "Food", "upi", 0, 0]);
    expect(table("txn").rows[1].slice(-2)).toEqual([1, 1]);
    expect(table("split").rows).toEqual([["T1", 224700, 58400]]);
    expect(JSON.stringify(tables)).not.toContain("id-a");
  });

  test("open amounts never go below zero", () => {
    expect(table("split_participant").rows).toEqual([["T1", "Nitin", 107900, 120000, 0]]);
    expect(table("owed_expense").rows).toEqual([["Nitin", "2026-09-02", 30000, "Movie", 10000, 20000]]);
  });

  test("the brief lists every table and column; describe_table gives the detail", () => {
    const brief = queryBrief();
    for (const t of QUERY_TABLES) expect(brief).toContain(`${t.name}(${t.columns.map((c) => c.name).join(", ")})`);
    expect(describeTable("Split_Participant")).toMatchObject({ table: "split_participant", joins: expect.any(String) });
    expect(describeTable("user")).toBeNull();
  });
});

describe("query results for the model", () => {
  test("money columns, and only those, are shown in rupees", () => {
    expect(["paise", "total_paise", "sum(paise)", "SUM(p.open_paise)"].every(isMoneyColumn)).toBe(true);
    expect(["count(paise)", "n", "paise_count", "date"].some(isMoneyColumn)).toBe(false);
    expect(
      formatQueryResult({ columns: ["category", "spent_paise", "count(paise)"], rows: [["Food", 274700, 2]], truncated: false }),
    ).toEqual({ columns: ["category", "spent_paise", "count(paise)"], rows: [["Food", "₹2,747.00", 2]], row_count: 1, truncated: false });
  });

  test("an average is rounded to whole paise", () => {
    expect(formatQueryResult({ columns: ["avg_paise"], rows: [[33333.333]], truncated: false }).rows).toEqual([["₹333.33"]]);
  });

  test("a huge result is cut down and says so", () => {
    const rows = Array.from({ length: 100 }, (_, i) => [`T${i}`, "x".repeat(200)]);
    const out = formatQueryResult({ columns: ["ref", "note"], rows, truncated: false });
    expect(out.row_count).toBeLessThan(100);
    expect(out.truncated).toBe(true);
    expect(out.next).toBeDefined();
  });
});
