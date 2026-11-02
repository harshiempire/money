import { afterEach, describe, expect, test } from "bun:test";
import { createQuerySandbox, sandboxSpawnArgs, type QuerySandbox } from "./query-sandbox";
import { buildQueryTables, type QueryData } from "./query-tables";

// The sandbox runs real Node (Bun has no SQLite authorizer).
const data: QueryData = {
  txns: [
    { id: "a", date: "2026-08-06", paise: 224700, direction: "paid", payee: "Etsi", note: "dinner", category: "Food", channel: "upi", isTransfer: false, netSettled: false },
    { id: "b", date: "2026-08-07", paise: 50000, direction: "paid", payee: "Swiggy", note: null, category: "Food", channel: "upi", isTransfer: false, netSettled: false },
    { id: "c", date: "2026-08-09", paise: 1000000, direction: "paid", payee: "Own savings", note: null, category: null, channel: "imps", isTransfer: true, netSettled: false },
    { id: "d", date: "2026-09-01", paise: 107900, direction: "received", payee: "Nitin", note: null, category: null, channel: "upi", isTransfer: false, netSettled: true },
  ],
  categories: [{ name: "Food", kind: "spend" }],
  people: ["Nitin", "Sai Abhinav"],
  splits: [{ txnId: "a", totalPaise: 224700, yourSharePaise: 58400 }],
  participants: [
    { txnId: "a", person: "Nitin", expectedPaise: 107900, settledPaise: 107900 },
    { txnId: "a", person: "Sai Abhinav", expectedPaise: 58400, settledPaise: 0 },
  ],
  owed: [],
};
const refs = new Map<string, string>();
const refFor = (id: string) => refs.get(id) ?? (refs.set(id, `T${refs.size + 1}`), refs.get(id)!);
const tables = buildQueryTables(data, refFor);

let sandbox: QuerySandbox | null = null;
afterEach(() => sandbox?.close());
const open = (opts = {}) => (sandbox = createQuerySandbox(async () => tables, opts));

describe("query sandbox", () => {
  test("answers a question exactly, in paise", async () => {
    const r = await open().run(
      "select category, sum(paise) as spent_paise, count(*) as n from txn where direction = 'paid' and is_transfer = 0 group by category",
    );
    expect(r).toEqual({ ok: true, columns: ["category", "spent_paise", "n"], rows: [["Food", 274700, 2]], truncated: false });
  });

  test("joins splits to transactions by ref", async () => {
    const r = await open().run(
      "select t.payee, p.person, p.open_paise from split_participant p join txn t on t.ref = p.txn_ref where p.open_paise > 0",
    );
    expect(r).toEqual({ ok: true, columns: ["payee", "person", "open_paise"], rows: [["Etsi", "Sai Abhinav", 58400]], truncated: false });
  });

  test("allows LIKE, dates and window functions", async () => {
    const s = open();
    expect((await s.run("select ref from txn where payee like 'swig%'")).ok).toBe(true);
    expect((await s.run("select strftime('%Y-%m', date) m, sum(paise) from txn group by m")).ok).toBe(true);
    expect((await s.run("select ref, row_number() over (order by paise desc) from txn")).ok).toBe(true);
  });

  test.each([
    ["a write", "insert into txn (ref) values ('T9')"],
    ["a delete hidden in a CTE", "with x as (delete from txn returning *) select * from x"],
    ["a second statement", "select 1; delete from txn"],
    ["a PRAGMA", "pragma query_only = off"],
    ["ATTACH", "attach database ':memory:' as other"],
    ["the schema table", "select * from sqlite_schema"],
    ["a recursive query", "with recursive c(n) as (select 1 union all select n + 1 from c) select count(*) from c"],
    ["a memory bomb", "select zeroblob(1000000000)"],
    ["randomness", "select random()"],
    ["loading an extension", "select load_extension('x')"],
  ])("refuses %s", async (_label, sql) => {
    const s = open();
    const r = await s.run(sql);
    expect(r.ok).toBe(false);
    // The data is untouched and the engine still answers.
    expect(await s.run("select count(*) from txn")).toMatchObject({ ok: true, rows: [[4]] });
  });

  test("stops a slow query by killing the process, then starts a fresh one", async () => {
    const s = open({ queryTimeoutMs: 700 });
    const started = Date.now();
    // 4^16 ≈ 4 billion row combinations: far longer than the limit.
    const slow = await s.run(`select count(*) from ${Array.from({ length: 16 }, (_, i) => `txn t${i}`).join(", ")}`);
    expect(slow.ok).toBe(false);
    expect(slow.ok ? "" : slow.error).toContain("took longer");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await s.run("select count(*) from txn")).toMatchObject({ ok: true, rows: [[4]] });
  });

  test("caps the rows it returns", async () => {
    const r = await open({ maxRows: 2 }).run("select ref from txn");
    expect(r).toMatchObject({ ok: true, rows: [["T1"], ["T2"]], truncated: true });
  });

  test("after close, nothing runs", async () => {
    const s = open();
    s.close();
    expect((await s.run("select 1")).ok).toBe(false);
  });

  test("the process gets no environment and no file or process access", () => {
    const { args, options } = sandboxSpawnArgs("node");
    expect(options.env).toEqual({});
    expect(args).toContain("--permission");
  });
});
