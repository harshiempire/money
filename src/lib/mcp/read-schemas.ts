import { Schema } from "effect";
import { Day } from "./schemas";
import { TransactionView } from "./view";

const text = (description: string) => Schema.String.annotate({ description });
const nullable = (description: string) => Schema.NullOr(Schema.String).annotate({ description });
const money = (description: string) => text(description + " Exact rupee decimal string, two fractional digits.");
const count = (description: string) => Schema.Int.annotate({ description });
const flag = (description: string) => Schema.Boolean.annotate({ description });
const name = text("Full person name, grouped case-insensitively after trimming.");
const ref = text("Opaque account-bound HMAC reference; never a database id.");
const txnRef = text("Opaque txn_ reference accepted by the other transaction tools.");
const via = Schema.Literals(["bank", "cash", "writeoff", "net"]).annotate({ description: "net when net_event_id exists or method is offset; otherwise bank, cash or writeoff. Writeoffs forgive debt without moving money." });
const owedFields = {
  ref, person: name, date: text("Expense incurred date, YYYY-MM-DD."), what: text("Full expense description, including overpayment descriptions."),
  amount: money("Original user-owned owed expense; money you owe this person."), settled: money("Sum of all settlements against this owed expense."), left: money("max(0, amount minus settled)."),
};
const shareSettlement = Schema.Struct({ ref, amount: money("Amount allocated to this share; includes forgiven and offset amounts."), date: text("Bank transaction date, else net-event date, else settlement creation date in UTC."), via,
  inflow_ref: nullable("txn_ ref of the bank inflow in this account, or null for cash, writeoff, offset, or an inflow outside this account.") });
const splitFields = {
  total: money("Full split total, including your share."), your_share: money("Owner's share, before writeoffs."),
  shares: Schema.Array(Schema.Struct({ ref, person: name, expected: money("Participant's original share."), settled: money("All allocations, including cash, writeoffs and net offsets, regardless of date."), left: money("max(0, expected minus settled)."),
    settlements: Schema.Array(shareSettlement).annotate({ description: "Allocations against this person's share, oldest first." }) })).annotate({ description: "One entry per split participant; shr_ references identify shares." }),
};
export const DetailedTransaction = Schema.Struct({
  ...TransactionView.fields,
  split: Schema.NullOr(Schema.Struct(splitFields)).annotate({ description: "The transaction's split with all participants and settlement allocations, or null." }),
  settles: Schema.Array(Schema.Struct({ ref, amount: money("Allocation from this bank inflow."), share_ref: nullable("shr_ target, or null when the target is an owed expense."), owed_ref: nullable("owe_ target, or null when the target is a share."), person: name,
    for_txn_ref: nullable("Original split bill's txn_ ref; null for an owed-expense target.") })).annotate({ description: "What this inflow has been allocated to, including bank legs of net events." }),
  net_event: Schema.NullOr(Schema.Struct({ person: text("Person names derived from the event's settlement targets; multiple names are comma-separated."), role: Schema.Literals(["inflow", "outflow"]).annotate({ description: "This transaction's role in the net event." }),
    other_ref: nullable("Other bank leg's txn_ ref, or null if absent or outside this account."), amount: money("Gross debt resolved: max(total receivable legs, total payable legs), counting offset debt once; not necessarily this bank transaction's amount.") })).annotate({ description: "Linked net event, or null. People and gross amount are derived from its settlement legs." }),
  owed_expenses: Schema.Array(Schema.Struct(owedFields)).annotate({ description: "User-owned owed expenses sourced from this credit, usually an owed-back overpayment; includes settled ones." }),
});
export const GetTransactionsInput = Schema.Struct({ refs: Schema.Array(text("txn_ ref from any MCP read tool, including query.")).check(Schema.isBetweenLength(1, 50)).annotate({ description: "1–50 transaction refs. Unknown or foreign refs are returned in unknown_refs." }) });
export const GetTransactionsOutput = Schema.Struct({ transactions: Schema.Array(DetailedTransaction).annotate({ description: "Found transactions, in requested order, deduplicated." }), unknown_refs: Schema.Array(text("Requested ref unavailable in this account.")).annotate({ description: "Unknown, malformed or foreign refs, without revealing whether they exist elsewhere." }) });
const balanceFields = {
  owed_to_you: money("All-time outstanding split shares in this account after all settlements including writeoffs; excludes owed expenses."),
  you_owe: money("All-time outstanding user-owned owed expenses after all settlements; excludes split shares. User-scoped, across accounts."),
};
const seenHandle = Schema.Struct({ key: text("Counterparty key used by a bank inflow that settled this person's share or owed expense."), handle: nullable("UPI handle when key kind is upi_handle; otherwise null."), display_name: nullable("Full counterparty display name, if present."),
  count: count("Distinct inflow transactions for this person and key; a payment covering multiple shares counts once."), last_date: text("Latest such inflow date, YYYY-MM-DD.") });
export const PeopleOutput = Schema.Struct({ people: Schema.Array(Schema.Struct({ name, ...balanceFields, open_share_count: count("Shares with positive outstanding amount; excludes owed expenses."), last_activity_date: nullable("Latest split bill, owed-expense or settlement date, or null for a person with no activity."),
  seen_handles: Schema.Array(seenHandle).annotate({ description: "Learned from settlements, not confirmed. A person may have several handles and a handle may have paid for several people." }) })).annotate({ description: "Every saved person plus historical share/owed-expense names, grouped case-insensitively after trimming; alphabetical." }) });
export const OpenBalancesInput = Schema.Struct({ person: Schema.optionalKey(text("Case-insensitive exact full person name after trimming. Omit for all people with a non-zero balance; unknown names return close names.")) });
export const OpenBalancesOutput = Schema.Struct({ people: Schema.Array(Schema.Struct({ name, ...balanceFields,
  lines: Schema.Array(Schema.Union([
    Schema.Struct({ kind: Schema.Literal("share").annotate({ description: "They owe you for a split bill." }), ref, txn_ref: txnRef, date: text("Original split transaction date."), what: text("Transaction note if present, otherwise its payee."), expected: money("Original share amount."), settled: money("Sum of all settlements including writeoffs."), left: money("Positive outstanding share amount.") }),
    Schema.Struct({ kind: Schema.Literal("owed").annotate({ description: "You owe them for an expense." }), ref, date: owedFields.date, what: owedFields.what, amount: owedFields.amount, settled: owedFields.settled, left: owedFields.left }),
  ])).annotate({ description: "Only open shares and owed expenses, oldest first together; ties by ref." }),
  unlinked_inflows: Schema.Array(Schema.Struct({ txn_ref: txnRef, date: text("Credit date."), amount: money("Full unallocated credit amount."), handle: nullable("UPI handle, or null for a non-UPI counterparty.") })).annotate({ description: "Up to 20 newest credits from this person's learned counterparty keys with no settlement, net event or sourced owed expense. Learned associations are not confirmed." }),
})).annotate({ description: "Balances and oldest-first open lines for the requested people." }) });
export const PayeeView = Schema.Struct({
  key: text("Full counterparty key, scoped to this user's account transactions."), kind: text("Counterparty kind, e.g. upi_handle."), handle: nullable("Key for upi_handle kind; otherwise null."), display_name: nullable("Full user/display name, if set."), default_category: nullable("Full default category name, or null."), is_self: flag("Whether marked as the owner's own counterparty."), is_family: flag("Whether marked as family."),
  row_count: count("Bank rows with this key in this account, including transfers."), paid_total: money("Sum of full debit amounts for this key, including transfers and splits."), received_total: money("Sum of full credit amounts for this key, including transfers and settlements."), first_date: nullable("Earliest bank transaction date for this key."), last_date: nullable("Latest bank transaction date for this key."),
  seen_person: Schema.Array(name).annotate({ description: "People whose shares or owed expenses this payee's inflows settled. Learned from settlements, not confirmed; may contain several names." }),
});
export const PayeesInput = Schema.Struct({ query: Schema.optionalKey(text("Case-insensitive substring over key and display_name.")), limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({ description: "Rows per page, 1–100; default 50." })), cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096)).annotate({ description: "Opaque next_cursor from a previous list_payees page with the same query." })) });
export const PayeesOutput = Schema.Struct({ payees: Schema.Array(PayeeView).annotate({ description: "Counterparties for this account, sorted by row_count descending then key." }), next_cursor: nullable("Opaque next-page cursor; null on the final page.") });
const searchText = (description: string) => Schema.String.check(Schema.isMaxLength(200), Schema.makeFilter((s: string) => s.trim().length > 0, { expected: "non-blank text" })).annotate({ description });
export const FindPaymentsInput = Schema.Struct({
  amount: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^(0|[1-9]\d{0,12})(\.\d{1,2})?$/), Schema.makeFilter((s: string) => Number(s) > 0 && Number.isSafeInteger(Math.round(Number(s) * 100)), { expected: "positive rupee amount with at most two fractional digits" })).annotate({ description: "Exact positive rupee decimal string. Match transaction amount or an expected participant share; amounts within ±2% of the transaction are weaker matches." })),
  date: Schema.optionalKey(Day.annotate({ description: "Target date. Without from/to, search ±7 days around it; nearer dates score higher." })),
  from: Schema.optionalKey(Day.annotate({ description: "Inclusive start date; overrides the implicit ±7-day window." })), to: Schema.optionalKey(Day.annotate({ description: "Inclusive end date; overrides the implicit ±7-day window." })),
  direction: Schema.optionalKey(Schema.Literals(["paid", "received"]).annotate({ description: "Only debits (paid) or credits (received)." })),
  text: Schema.optionalKey(searchText("Case-insensitive substring over payee, handle, raw bank description and note.")), person: Schema.optionalKey(searchText("Exact full name, case-insensitive after trim. Match split participants, notes mentioning this name, or settlement-learned counterparty keys.")),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 })).annotate({ description: "Maximum candidates; default 10, maximum 25." })),
}).check(Schema.makeFilter((v) => (v.amount !== undefined || v.text !== undefined || v.person !== undefined) && !(v.from && v.to && v.from > v.to), {
  expected: "at least one of amount, text or person, and from <= to", toJsonSchema: () => ({ anyOf: [{ required: ["amount"] }, { required: ["text"] }, { required: ["person"] }] }),
}));
export type FindPaymentsInput = typeof FindPaymentsInput.Type;
export const FindPaymentsOutput = Schema.Struct({ candidates: Schema.Array(Schema.Struct({ ...TransactionView.fields, score: count("Deterministic relevance score; higher is better. Scores are ranking aids, not probabilities."), reasons: Schema.Array(text("Evidence for this candidate, e.g. exact amount, matching share, date distance, payee or learned handle.")).annotate({ description: "All matching signals used in the score." }), split_summary: Schema.NullOr(Schema.Struct({ total: splitFields.total, your_share: splitFields.your_share, shares: Schema.Array(Schema.Struct({ person: name, expected: money("Original participant amount."), left: money("Outstanding after all settlements.") })).annotate({ description: "Participants' expected and outstanding shares." }) })).annotate({ description: "Split totals and participants, or null when unsplit." }) })).annotate({ description: "Ranked matches, highest score first, then newest date and ref." }) });
export const QueryInput = Schema.Struct({ sql: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)).annotate({ description: "One read-only SQLite SELECT or WITH statement over the curated tables. Money is integer paise in SQL; keep result money aliases ending in _paise for automatic exact rupee formatting. Fractional aggregate paise are rounded to the nearest paise. Maximum 100 result rows." }) });
export const QueryOutput = Schema.Struct({ columns: Schema.Array(text("SQL result column label.")).annotate({ description: "Result column names, in order." }), rows: Schema.Array(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Null]))).annotate({ description: "Result cells; money columns are exact rupee strings, other cells are strings, numbers or null." }), row_count: count("Rows returned, at most 100."), truncated: flag("Whether the sandbox or response size limit truncated the result.") });
export const DescribeTableInput = Schema.Struct({ name: text("Table name; case-insensitive. Tables: transactions, payees, people, splits, shares, settlements, net_events, owed, categories, standing_notes.") });
export const DescribeTableOutput = Schema.Struct({ table: text("Canonical table name."), about: text("Table's scope and semantics."), columns: Schema.Array(Schema.Struct({ name: text("SQL column name."), type: text("SQLite TEXT or INTEGER."), about: text("Column's precise meaning and units.") })).annotate({ description: "Allowed columns and their definitions." }), joins: nullable("Ref/name joins to other curated tables, if applicable.") });
