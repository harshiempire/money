/** MCP-only curated model. Ask Money's redacted QUERY_TABLES are deliberately independent. */
import type { QueryTableSpec, SandboxTable, SqlValue } from "@/lib/assistant/query-tables";
import { isMoneyColumn } from "@/lib/assistant/query-tables";
import { McpToolError } from "./pagination";
import type { McpReadView } from "./model-view";
import { amountPaise } from "./find-payments";
import { rupees } from "./view";

type Column = readonly [name: string, type: "TEXT" | "INTEGER", about: string];
const table = (name: string, about: string, columns: readonly Column[], joins?: string): QueryTableSpec => ({ name, about, columns: columns.map(([name, type, about]) => ({ name, type, about })), joins });
const T = "TEXT", I = "INTEGER";
export const MCP_QUERY_TABLES: QueryTableSpec[] = [
  table("transactions", "Every bank row in the selected account. No owed expenses. category IS NULL means uncategorized, including credits and transfers.", [
    ["ref", T, "Opaque txn_ reference, valid in every MCP tool."], ["date", T, "Bank date YYYY-MM-DD."], ["amount_paise", I, "Full bank amount as positive integer paise; includes transfers and other people's split shares."], ["direction", T, "paid for debit, received for credit."],
    ["payee", T, "Display name, else purpose, key, bank label."], ["handle", T, "Full UPI key for upi_handle, else null."], ["raw_description", T, "Full unredacted bank description."], ["purpose", T, "Parsed bank remark; truncated to 1–4 letters by bank. Do not infer meaning."], ["note", T, "Full owner note, or null."], ["category", T, "Full category name, or null."], ["is_transfer", I, "1 for own-account transfer, else 0."], ["needs_review", I, "1 when flagged for review, else 0."],
    ["person", T, "Confirmed linked person; else one learned name or a JSON array for multiple learned names; else null."], ["via", T, "linked for confirmed person, seen for settlement evidence, else null."],
  ]),
  table("payees", "Counterparties appearing in this account. person and via distinguish confirmed links from settlement evidence.", [
    ["key", T, "Full counterparty key."], ["kind", T, "Counterparty kind."], ["handle", T, "Key when kind is upi_handle, else null."], ["display_name", T, "Full display name or null."], ["default_category", T, "Full default category name or null."], ["is_self", I, "1 if self, else 0."], ["is_family", I, "1 if family, else 0."], ["seen_person", T, "JSON array of people whose shares/owed expenses this key's inflows settled; learned, not confirmed."],
    ["person", T, "Confirmed linked person; else one learned name or a JSON array for multiple learned names; else null."], ["via", T, "linked for confirmed person, seen for settlement evidence, else null."],
  ], "payees.handle = transactions.handle (UPI); json_each is not allowed, use list_payees for individual associations"),
  table("people", "Saved and historical names grouped case-insensitively after trim, including zero balances.", [
    ["name", T, "Canonical trimmed name."], ["owed_to_you_paise", I, "Sum of max(0, expected minus ALL settlements including writeoffs) over this account's shares."], ["you_owe_paise", I, "Sum of max(0, amount minus ALL settlements) over user-owned owed expenses across accounts."],
  ]),
  table("splits", "One row per split, identified by its bank transaction ref.", [["txn_ref", T, "Bank transaction's txn_ ref."], ["total_paise", I, "Full split amount."], ["your_share_paise", I, "Owner's original share, before writeoffs."], ["split_rev", T, "Opaque revision required for split replacement or deletion; read current transaction rev with get_transactions."]], "splits.txn_ref = transactions.ref"),
  table("shares", "Other people's shares, including fully settled and forgiven ones.", [
    ["ref", T, "Opaque shr_ ref."], ["txn_ref", T, "Original bill's txn_ ref."], ["person", T, "Canonical person name."], ["expected_paise", I, "Original participant share."], ["settled_paise", I, "All settlements including writeoffs and net offsets, regardless of date."], ["left_paise", I, "max(0, expected minus settled)."],
  ], "shares.txn_ref = transactions.ref; shares.person = people.name"),
  table("settlements", "One allocation per row; includes bank, cash, forgiven debt and net-event legs.", [
    ["ref", T, "Opaque stl_ ref."], ["inflow_ref", T, "txn_ ref of inflow in this account, else null."], ["share_ref", T, "shr_ target or null; exactly one target is present."], ["owed_ref", T, "owe_ target or null."], ["person", T, "Canonical target person name."], ["amount_paise", I, "Allocated integer paise; writeoffs move no money."], ["date", T, "Bank date, else event date, else UTC settlement creation date."], ["via", T, "net if net_event_id exists or method is offset, otherwise bank/cash/writeoff."],
  ], "settlements.share_ref = shares.ref; settlements.owed_ref = owed.ref; settlements.inflow_ref = transactions.ref"),
  table("net_events", "User-owned net events. External bank legs are null. People and gross debt are derived from settlement targets.", [
    ["person", T, "Canonical names of the event's targets, comma-separated for multiple people."], ["inflow_ref", T, "Bank inflow txn_ ref or null."], ["outflow_ref", T, "Bank outflow txn_ ref or null."], ["amount_paise", I, "Gross debt resolved: max(sum receivable legs, sum payable legs); offset debt counted once, not the bank amount."],
  ], "net_events.inflow_ref/outflow_ref = transactions.ref"),
  table("owed", "All user-owned owed expenses, including owed-back overpayments and settled ones. Separate from shares.", [
    ["ref", T, "Opaque owe_ ref."], ["person", T, "Canonical creditor name."], ["date", T, "Incurred date YYYY-MM-DD."], ["what", T, "Full description."], ["amount_paise", I, "Original amount you owe them."], ["settled_paise", I, "All allocations against this expense."], ["left_paise", I, "max(0, amount minus settled)."],
  ], "owed.person = people.name"),
  table("categories", "User-owned categories, unfiltered.", [["name", T, "Full category name."], ["kind", T, "Category kind such as spend, transfer, reimbursement, investment or income."]], "categories.name = transactions.category"),
  table("standing_notes", "Owner's full standing notes, unfiltered.", [["body", T, "Full note text."]]),
];
export function describeMcpTable(name: string) {
  const t = MCP_QUERY_TABLES.find((t) => t.name === name.trim().toLowerCase());
  if (!t) throw new McpToolError(`Unknown table '${name}'. Tables: ${MCP_QUERY_TABLES.map((t) => t.name).join(", ")}.`);
  return { table: t.name, about: t.about, columns: t.columns, joins: t.joins ?? null };
}
export function buildMcpQueryTables(view: McpReadView, categories: readonly { name: string; kind: string }[], notes: readonly string[]): SandboxTable[] {
  const association = (p: { person: string | null; seen_person: string[] } | undefined): SqlValue[] => p?.person ? [p.person, "linked"] : p?.seen_person.length ? [p.seen_person.length === 1 ? p.seen_person[0] : JSON.stringify(p.seen_person), "seen"] : [null, null];
  const rows: Record<string, SqlValue[][]> = {
    transactions: view.transactions.map((t) => [t.ref, t.date, amountPaise(t.amount), t.direction, t.payee, t.handle, t.raw_description, t.purpose, t.note, t.category, Number(t.transfer), Number(t.needs_review), ...association(view.payees.find(p => p.key === view.transactionKeys.get(t.ref)))]),
    payees: view.payees.map((p) => [p.key, p.kind, p.handle, p.display_name, p.default_category, Number(p.is_self), Number(p.is_family), JSON.stringify(p.seen_person), ...association(p)]),
    people: view.people.map((p) => [p.name, amountPaise(p.owed_to_you), amountPaise(p.you_owe)]),
    splits: view.splits.map((s) => [s.txn_ref, amountPaise(s.total), amountPaise(s.your_share), s.split_rev]),
    shares: view.shares.map((s) => [s.ref, s.txn_ref, s.person, amountPaise(s.expected), amountPaise(s.settled), amountPaise(s.left)]),
    settlements: view.settlements.map((s) => [s.ref, s.inflow_ref, s.share_ref, s.owed_ref, s.person, amountPaise(s.amount), s.date, s.via]),
    net_events: view.netEvents.map((e) => [e.person, e.inflow_ref, e.outflow_ref, amountPaise(e.amount)]),
    owed: view.owed.map((o) => [o.ref, o.person, o.date, o.what, amountPaise(o.amount), amountPaise(o.settled), amountPaise(o.left)]),
    categories: categories.map((c) => [c.name, c.kind]), standing_notes: notes.map((body) => [body]),
  };
  return MCP_QUERY_TABLES.map((t) => ({ name: t.name, columns: t.columns.map(({ name, type }) => ({ name, type })), rows: rows[t.name] }));
}
/** Shared detection rules; MCP uses exact decimal strings instead of Ask Money's display currency prefix. */
export function formatMcpQueryResult(result: { columns: string[]; rows: SqlValue[][]; truncated: boolean }) {
  const money = result.columns.map(isMoneyColumn);
  let rows = result.rows.map((row) => row.map((v, i) => {
    if (!money[i] || typeof v !== "number") return v;
    // SQL averages can have fractional paise; match Ask Money by rounding to the nearest paise.
    const paise = Math.round(v);
    if (!Number.isSafeInteger(paise)) throw new McpToolError("Query money exceeds the exact paise range. Narrow the query, and keep money aliases ending in _paise.");
    return rupees(paise);
  }));
  let truncated = result.truncated;
  while (rows.length > 1 && JSON.stringify(rows).length > 12_000) { rows = rows.slice(0, Math.floor(rows.length / 2)); truncated = true; }
  return { columns: result.columns, rows, row_count: rows.length, truncated };
}
