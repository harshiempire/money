import { Schema } from "effect";
import { readHistory, type TagFact } from "@/lib/assistant/tag-batch";
import { resolveMcpPeriod } from "./range";
import type { PeriodInput } from "./schemas";
import { TransactionView } from "./view";
import { unlinkedInflows, type McpReadView } from "./model-view";

const within = (date: string, bounds: ReturnType<typeof resolveMcpPeriod>) => (!bounds.from || date >= bounds.from) && (!bounds.to || date <= bounds.to);
const generic = new Set(["payee", "self", "unknown", "opening balance"]);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** MCP uses the same deterministic history/conflict rules, with no model guesses. */
export function suggestCategories(view: McpReadView, categories: readonly { id: string; name: string; kind: string }[], input: PeriodInput) {
  const bounds = resolveMcpPeriod(input);
  const facts: TagFact[] = view.transactions.map(t => {
    const key = view.transactionKeys.get(t.ref) ?? null;
    const known = key && !generic.has(key.trim().toLowerCase()) && !generic.has(t.payee.trim().toLowerCase());
    return { id: t.ref, txnDate: t.date, amountPaise: 0, drCr: t.direction === "paid" ? "debit" : "credit", channel: t.channel,
      categoryId: categories.find(c => c.name === t.category)?.id ?? null, isTransfer: t.transfer,
      counterpartyId: known ? key : null, displayName: known ? t.payee : "Payee", parsedPurpose: null,
      label: "Payee", note: null, bankRefId: "", defaultCategoryId: categories.find(c => c.name === t.payee_default)?.id ?? null };
  });
  const rows = view.transactions.filter(t => view.uncategorizedRefs.has(t.ref) && within(t.date, bounds)).map(t => {
    const target = facts.find(f => f.id === t.ref)!;
    const history = readHistory(target, facts.filter(f => f.txnDate < target.txnDate), [...categories]);
    let suggestion: string | null = null, source: "payee_default" | "history" | "note" | null = null, sure = false;
    const conflict = history.kind === "conflict" ? history.choices.map(c => c.name) : [];
    if (!conflict.length) {
      if (t.payee_default) { suggestion = t.payee_default; source = "payee_default"; sure = true; }
      else if (history.kind === "match") {
        suggestion = categories.find(c => c.id === history.categoryId)?.name ?? null;
        source = "history"; sure = history.support >= 2;
      }
      // An explicit owner note is sure even when history has only one example.
      if (!sure && t.note) {
        const named = categories.filter(c => new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegex(c.name)}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(t.note!));
        if (named.length === 1) { suggestion = named[0].name; source = "note"; sure = true; }
      }
    }
    return { ref: t.ref, rev: t.rev, date: t.date, amount: t.amount, payee: t.payee, handle: t.handle, note: t.note, suggestion, source, sure, conflict };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  const groups = new Map<string, { payee: string; handle: string | null; count: number; refs: string[] }>();
  for (const row of rows.filter(r => !r.sure)) {
    // Missing/generic payees cannot safely be grouped as one person.
    const key = view.transactionKeys.get(row.ref);
    const groupKey = key && !generic.has(key.toLowerCase()) ? key : !generic.has(row.payee.trim().toLowerCase()) ? row.payee : row.ref;
    const group = groups.get(groupKey) ?? { payee: row.payee, handle: row.handle, count: 0, refs: [] };
    group.count++; group.refs.push(row.ref); groups.set(groupKey, group);
  }
  return { rows, unsure_groups: [...groups.values()].sort((a, b) => b.count - a.count || a.payee.localeCompare(b.payee)) };
}

/** Period membership is the bill date; all settlements still reduce its open share. */
export function reviewPeriod(view: McpReadView, input: PeriodInput) {
  const bounds = resolveMcpPeriod(input), rows = view.transactions.filter(t => within(t.date, bounds));
  const unexplained = rows.filter(t => view.uncategorizedRefs.has(t.ref) && !t.note?.trim());
  const amountCounts = new Map<string, number>(), payeeCounts = new Map<string, number>();
  for (const t of unexplained) {
    amountCounts.set(t.amount, (amountCounts.get(t.amount) ?? 0) + 1);
    const key = view.transactionKeys.get(t.ref);
    if (key && !generic.has(key.trim().toLowerCase())) {
      const pair = JSON.stringify([t.amount, key]); payeeCounts.set(pair, (payeeCounts.get(pair) ?? 0) + 1);
    }
  }
  const list = <T>(rows: T[]) => ({ count: rows.length, rows });
  return {
    uncategorized: list(rows.filter(t => view.uncategorizedRefs.has(t.ref))),
    open_shares: list(view.shares.filter(s => s.left !== "0.00" && within(s.date, bounds))),
    unlinked_inflows: list(unlinkedInflows(view).filter(t => within(t.date, bounds))),
    repeated_amounts: list(unexplained.filter(t => (amountCounts.get(t.amount) ?? 0) >= 3 ||
      (payeeCounts.get(JSON.stringify([t.amount, view.transactionKeys.get(t.ref)])) ?? 0) >= 2)),
  };
}

const text = (description: string) => Schema.String.annotate({ description });
const maybe = (description: string) => Schema.NullOr(Schema.String).annotate({ description });
const ref = text("Opaque txn_ ref accepted by update_transactions and get_transactions.");
const date = text("Bank date YYYY-MM-DD."), amount = text("Exact rupee decimal string, two fractional digits.");
const payee = text("Full payee name from the MCP bank view."), handle = maybe("UPI handle, else null.");
export const SuggestCategoriesOutput = Schema.Struct({
  rows: Schema.Array(Schema.Struct({ ref, rev: text("Current opaque revision for guarded update_transactions."), date, amount, payee, handle,
    note: maybe("Full owner note, else null."), suggestion: maybe("Exact suggested category name, else null."),
    source: Schema.NullOr(Schema.Literals(["payee_default", "history", "note"])).annotate({ description: "Deterministic evidence only; never a model guess." }),
    sure: Schema.Boolean.annotate({ description: "True only for a nonconflicting default, two earlier same-payee payments in one category, or a note naming exactly one category." }),
    conflict: Schema.Array(text("Previously used category name.")).annotate({ description: "Conflicting prior categories/default; empty when unambiguous. A conflict is never sure." }),
  })).annotate({ description: "Every uncategorized bank row in the requested period, including credits and transfers; date/ref order." }),
  unsure_groups: Schema.Array(Schema.Struct({ payee, handle, count: Schema.Int.annotate({ description: "Number of unsure bank rows for this payee." }),
    refs: Schema.Array(ref).annotate({ description: "Unsure rows to ask about together." }),
  })).annotate({ description: "Rows not marked sure, grouped by payee; largest group first." }),
});
const list = <S extends Schema.Top>(row: S, description: string) => Schema.Struct({
  count: Schema.Int.annotate({ description: "Total rows in this list; no pagination or truncation." }),
  rows: Schema.Array(row).annotate({ description }),
}).annotate({ description });
const via = Schema.Literals(["linked", "seen"]).annotate({ description: "linked is owner-confirmed; seen is learned from settlement inflows. Suggestions never qualify." });
export const ReviewPeriodOutput = Schema.Struct({
  uncategorized: list(TransactionView, "Bank rows with no category, including credits/transfers, excluding owed expenses."),
  open_shares: list(Schema.Struct({ ref: text("Opaque shr_ ref."), txn_ref: ref, person: text("Person who owes this share."), date,
    what: text("Bill note, else payee."), expected: amount, settled: amount, left: amount,
  }), "Shares on bills in this period with positive outstanding, subtracting all settlements regardless of settlement date."),
  unlinked_inflows: list(Schema.Struct({ ...TransactionView.fields, via,
    people: Schema.Array(Schema.Struct({ person: text("Person associated with this payee."), via })).annotate({ description: "Every confirmed or learned association for this credit." }),
  }), "Credits from confirmed or learned payees with no settlement, net event or sourced owed expense; one row per credit."),
  repeated_amounts: list(TransactionView, "Uncategorized rows with no note: same exact amount at least three times, or twice from the same payee, in this period."),
});
