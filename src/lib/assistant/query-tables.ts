/**
 * The tables the model can query: a read-only copy of one user's Money data,
 * built fresh for a turn (see query-sandbox.ts). Only fields the model may
 * see go in (model-view.ts) — no bank descriptions, UPI ids, ref ids,
 * balances or database ids. Transactions are known by the chat's refs.
 *
 * This file is the single description of those tables: it builds the rows,
 * writes the short brief in the model's instructions, and answers
 * describe_table when the model wants the detail.
 */
import { modelAmount } from "./model-view";

export type SqlType = "TEXT" | "INTEGER";
export type SqlValue = string | number | null;

export interface QueryColumn {
  name: string;
  type: SqlType;
  about: string;
}

export interface QueryTableSpec {
  name: string;
  about: string;
  columns: QueryColumn[];
  joins?: string;
}

export const QUERY_TABLES: QueryTableSpec[] = [
  {
    name: "txn",
    about: "Every transaction in the user's bank account, one row each.",
    columns: [
      { name: "ref", type: "TEXT", about: "The transaction's label in this chat (T1, T2…). Pass it to show_transactions." },
      { name: "date", type: "TEXT", about: "Transaction date, YYYY-MM-DD." },
      { name: "paise", type: "INTEGER", about: "Amount in paise (₹1 = 100), always positive. direction says which way it went." },
      { name: "direction", type: "TEXT", about: "'paid' (money out) or 'received' (money in)." },
      {
        name: "payee",
        type: "TEXT",
        about: "Who it was paid to or received from: the user's name for them, else the payment purpose, else the bank's payee name.",
      },
      { name: "note", type: "TEXT", about: "The user's own note, or null." },
      { name: "category", type: "TEXT", about: "Category name (see the category table), or null when uncategorised." },
      { name: "channel", type: "TEXT", about: "upi, imps, neft, rtgs, cheque, cash, card, opening or other." },
      {
        name: "is_transfer",
        type: "INTEGER",
        about: "1 for a transfer between the user's own accounts. Leave these out of spending and income.",
      },
      { name: "net_settled", type: "INTEGER", about: "1 when it is part of a net settlement with someone." },
    ],
  },
  {
    name: "category",
    about: "The user's categories.",
    columns: [
      { name: "name", type: "TEXT", about: "Category name, as used in txn.category." },
      { name: "kind", type: "TEXT", about: "spend, transfer, reimbursement, investment or income." },
    ],
    joins: "txn.category = category.name",
  },
  {
    name: "person",
    about: "People the user has split payments with.",
    columns: [{ name: "name", type: "TEXT", about: "The person's name." }],
  },
  {
    name: "split",
    about: "A payment the user made and shared with other people. One row per split payment.",
    columns: [
      { name: "txn_ref", type: "TEXT", about: "The payment that was split (txn.ref)." },
      { name: "total_paise", type: "INTEGER", about: "The whole payment." },
      { name: "your_share_paise", type: "INTEGER", about: "The user's own part of it." },
    ],
    joins: "split.txn_ref = txn.ref",
  },
  {
    name: "split_participant",
    about: "Each other person in a split, and what they owe the user for it.",
    columns: [
      { name: "txn_ref", type: "TEXT", about: "The split payment (txn.ref, split.txn_ref)." },
      { name: "person", type: "TEXT", about: "The person's name." },
      { name: "expected_paise", type: "INTEGER", about: "Their share of the payment." },
      { name: "settled_paise", type: "INTEGER", about: "What they have paid back so far." },
      { name: "open_paise", type: "INTEGER", about: "What they still owe the user: expected minus settled, never below 0." },
    ],
    joins: "split_participant.txn_ref = split.txn_ref = txn.ref; split_participant.person = person.name",
  },
  {
    name: "owed_expense",
    about: "Money the user owes other people: someone else paid for the user.",
    columns: [
      { name: "person", type: "TEXT", about: "Who the user owes." },
      { name: "date", type: "TEXT", about: "When it happened, YYYY-MM-DD." },
      { name: "paise", type: "INTEGER", about: "The amount owed in total." },
      { name: "what", type: "TEXT", about: "What it was for." },
      { name: "settled_paise", type: "INTEGER", about: "What the user has paid back so far." },
      { name: "open_paise", type: "INTEGER", about: "What the user still owes: paise minus settled, never below 0." },
    ],
    joins: "owed_expense.person = person.name",
  },
];

/** Functions a query may call. Everything else (random, zeroblob, load_extension…) is refused. */
export const QUERY_FUNCTIONS = [
  // aggregates
  "count", "sum", "total", "avg", "min", "max", "group_concat", "string_agg",
  // window
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead", "first_value", "last_value", "nth_value",
  // dates
  "date", "time", "datetime", "julianday", "unixepoch", "strftime",
  // text
  "lower", "upper", "length", "substr", "substring", "instr", "trim", "ltrim", "rtrim", "replace", "like", "glob", "concat", "concat_ws", "printf", "format",
  // numbers and nulls
  "abs", "round", "sign", "ceil", "ceiling", "floor", "coalesce", "ifnull", "nullif", "iif", "if", "typeof",
];

/** The few lines of the model's instructions that describe the tables. */
export function queryBrief(): string {
  return QUERY_TABLES.map((t) => `${t.name}(${t.columns.map((c) => c.name).join(", ")})`).join("\n");
}

export function describeTable(name: string): object | null {
  const t = QUERY_TABLES.find((x) => x.name === name.trim().toLowerCase());
  if (!t) return null;
  return {
    table: t.name,
    about: t.about,
    columns: t.columns.map((c) => ({ name: c.name, type: c.type, about: c.about })),
    joins: t.joins ?? null,
  };
}

/** One user's data, already reduced to what the model may see. Ids stay on the server. */
export interface QueryData {
  txns: Array<{
    id: string;
    date: string;
    paise: number;
    direction: "paid" | "received";
    payee: string;
    note: string | null;
    category: string | null;
    channel: string;
    isTransfer: boolean;
    netSettled: boolean;
  }>;
  categories: Array<{ name: string; kind: string }>;
  people: string[];
  splits: Array<{ txnId: string; totalPaise: number; yourSharePaise: number }>;
  participants: Array<{ txnId: string; person: string; expectedPaise: number; settledPaise: number }>;
  owed: Array<{ person: string; date: string; paise: number; what: string; settledPaise: number }>;
}

export interface SandboxTable {
  name: string;
  columns: Array<{ name: string; type: SqlType }>;
  rows: SqlValue[][];
}

const flag = (b: boolean) => (b ? 1 : 0);
const open = (total: number, settled: number) => Math.max(0, total - settled);

/** Rows for the sandbox, in each spec's column order. `refFor` hands out the chat refs. */
export function buildQueryTables(data: QueryData, refFor: (txnId: string) => string): SandboxTable[] {
  const rows: Record<string, SqlValue[][]> = {
    txn: data.txns.map((t) => [
      refFor(t.id),
      t.date,
      t.paise,
      t.direction,
      t.payee,
      t.note,
      t.category,
      t.channel,
      flag(t.isTransfer),
      flag(t.netSettled),
    ]),
    category: data.categories.map((c) => [c.name, c.kind]),
    person: data.people.map((p) => [p]),
    split: data.splits.map((s) => [refFor(s.txnId), s.totalPaise, s.yourSharePaise]),
    split_participant: data.participants.map((p) => [
      refFor(p.txnId),
      p.person,
      p.expectedPaise,
      p.settledPaise,
      open(p.expectedPaise, p.settledPaise),
    ]),
    owed_expense: data.owed.map((o) => [o.person, o.date, o.paise, o.what, o.settledPaise, open(o.paise, o.settledPaise)]),
  };
  return QUERY_TABLES.map((t) => ({
    name: t.name,
    columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
    rows: rows[t.name] ?? [],
  }));
}

/** A result column that holds paise: `paise`, `total_paise`, `sum(paise)` — but not `count(paise)`. */
export function isMoneyColumn(name: string): boolean {
  const n = name.trim().toLowerCase();
  return /paise\)?$/.test(n) && !/^count\s*\(/.test(n);
}

const MAX_RESULT_CHARS = 12_000;

/**
 * What the model gets back. Money columns are turned into rupees here, by
 * code, so the model never divides by 100 itself.
 */
export function formatQueryResult(r: { columns: string[]; rows: SqlValue[][]; truncated: boolean }) {
  const money = r.columns.map(isMoneyColumn);
  let rows = r.rows.map((row) =>
    row.map((v, i) => (money[i] && typeof v === "number" ? modelAmount(Math.round(v)) : v)),
  );
  let truncated = r.truncated;
  while (rows.length > 1 && JSON.stringify(rows).length > MAX_RESULT_CHARS) {
    rows = rows.slice(0, Math.floor(rows.length / 2));
    truncated = true;
  }
  return {
    columns: r.columns,
    rows,
    row_count: rows.length,
    truncated,
    ...(truncated ? { next: "Only the first rows are here. Narrow the query or aggregate it." } : {}),
  };
}
