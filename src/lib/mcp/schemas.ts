import { Schema } from "effect";
import { ProposalRejection, ProposalRow } from "./proposal";
import { TransactionView } from "./view";
import { UNCATEGORIZED_DESCRIPTION } from "@/domain/spend/uncategorized";
import { daysInMonth } from "./range";

export const Month = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/u)).annotate({
  description: "Calendar month in YYYY-MM format; cannot be combined with from/to. Omit all range fields for all time.",
});
export const EmptyInput = Schema.Struct({});
const Day = Schema.String.check(
  Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u),
  Schema.makeFilter((value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    return year >= 1 && day <= daysInMonth(year, month);
  }, { expected: "a valid calendar date", toJsonSchema: () => ({ format: "date" }) }),
).annotate({ description: "Calendar date in YYYY-MM-DD format, inclusive." });
const periodFields = {
  month: Schema.optionalKey(Month),
  from: Schema.optionalKey(Day),
  to: Schema.optionalKey(Day),
};
const validRange = Schema.makeFilter((input: { month?: string; from?: string; to?: string }) =>
  !(input.month !== undefined && (input.from !== undefined || input.to !== undefined)) &&
  !(input.from && input.to && input.from > input.to), {
    expected: "month OR inclusive from/to (from must be <= to); neither means all time",
    toJsonSchema: () => ({ not: { required: ["month"], anyOf: [{ required: ["from"] }, { required: ["to"] }] } }),
  });
export const PeriodInput = Schema.Struct(periodFields).check(validRange);
export type PeriodInput = typeof PeriodInput.Type;
export const ListTransactionsInput = Schema.Struct({
  ...periodFields,
  direction: Schema.optionalKey(Schema.Literals(["paid", "received"]).annotate({ description: "Only paid (debit) or received (credit) bank rows." })),
  category: Schema.optionalKey(Schema.String.annotate({ description: "Exact category name; case-sensitive." })),
  uncategorized: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "When true: " + UNCATEGORIZED_DESCRIPTION }),
  ),
  payee: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(160)).annotate({
      description: "Case-insensitive substring over payee, UPI handle and raw bank description. Handles and digits are accepted.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({
        minimum: 1,
        maximum: 100,
      }),
    ).annotate({ description: "Transactions per page, from 1 to 100; defaults to 50." }),
  ),
  cursor: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(256)).annotate({
      description: "Opaque next_cursor from the previous page with the same filters.",
    }),
  ),
}).check(validRange);
export type ListTransactionsInput = typeof ListTransactionsInput.Type;
export const CategoriesOutput = Schema.Struct({
  categories: Schema.Array(
    Schema.Struct({
      name: Schema.String.annotate({ description: "Exact category name to use in proposals." }),
      kind: Schema.String.annotate({ description: "Category kind, such as spend." }),
    }),
  ),
});
export const TransactionsOutput = Schema.Struct({
  transactions: Schema.Array(TransactionView).annotate({ description: "One page of the account's full transactions." }),
  next_cursor: Schema.NullOr(Schema.String).annotate({
    description: "Opaque cursor for the next page, or null when there are no more results.",
  }),
});
export const NotesOutput = Schema.Struct({
  notes: Schema.Array(Schema.String).annotate({ description: "Full standing notes written by the owner." }),
});
export const SummaryOutput = Schema.Struct({
  period: Schema.Struct({
    from: Schema.NullOr(Schema.String).annotate({
      description: "Inclusive period start date, or null for an unbounded period.",
    }),
    to: Schema.NullOr(Schema.String).annotate({
      description: "Inclusive period end date, or null for an unbounded period.",
    }),
    label: Schema.String.annotate({ description: "Display label for the resolved spending period." }),
    partial: Schema.Boolean.annotate({ description: "False: MCP reads the complete requested calendar range, without clipping at today." }),
  }),
  totals: Schema.Struct({
    total_debit: Schema.String.annotate({ description: "Sum of all bank debit amounts in the period, including transfers and the full amount of split bills; excludes credits and owed expenses. Exact rupee string." }),
    total_credit: Schema.String.annotate({ description: "Sum of all bank credit amounts in the period, including transfers and reimbursements; excludes debits and owed expenses. Exact rupee string." }),
    net_self: Schema.String.annotate({ description: "Non-transfer debit owner shares (unsplit: full amount; split: your_share plus written-off shares, capped at debit amount), minus non-transfer credit remainders after settlement allocations and owed-back expenses (clamped at zero per credit), plus full owed_expense amounts incurred in the period. Settled owed expenses still count. Exact rupee string." }),
    owed_self: Schema.String.annotate({
      description: "Full amounts of owed_expense rows incurred in the period, including settled ones and owed-back overpayments. Money the owner owes others; does not count split participant shares. Scoped by user. Exact rupee string.",
    }),
    count: Schema.Int.annotate({ description: "All bank transaction rows in the period, including credits, transfers and split bills counted once; excludes owed expenses." }),
  }),
  open_shares: Schema.String.annotate({ description: "Other people's outstanding split shares on bank transactions dated in the period: sum of max(0, expected minus all settlements, including writeoffs) per participant, even if settled after the period. Includes transfers and credits with splits; excludes owed_expense rows. Exact rupee string." }),
  bridge: Schema.Struct({
    personal_debit_gross: Schema.String.annotate({
      description: "Full bank debit amounts excluding transfers, before removing other people's split shares; excludes credits and owed expenses. Exact rupee string.",
    }),
    your_share_debit: Schema.String.annotate({
      description: "Non-transfer debits: full amount if unsplit, otherwise your_share plus written-off participant shares, capped at the debit amount. Excludes credits and owed expenses. Exact rupee string.",
    }),
    others_share: Schema.String.annotate({
      description: "Other people's split shares on non-transfer debits, less written-off shares: personal_debit_gross minus your_share_debit. Includes shares repaid by bank, cash or offset; excludes credits, transfers and owed_expense rows. Exact rupee string.",
    }),
    net_credit: Schema.String.annotate({
      description: "Non-transfer bank credits minus all settlements allocated to each credit and owed_expense amounts sourced from it, clamped at zero per credit. Kept or written-off residuals remain credit. Excludes debits. Exact rupee string.",
    }),
    split_txn_count: Schema.Int.annotate({ description: "Distinct non-transfer debit bank transactions with a split; excludes credits and owed expenses, regardless of settlement status." }),
  }),
  triage: Schema.Struct({
    uncategorized_net_self: Schema.String.annotate({
      description: "Bank-only net_self contribution of uncategorized rows (category_id null), including credit remainders; transfers contribute zero. Excludes all owed expenses. Exact rupee string.",
    }),
    uncategorized_count: Schema.Int.annotate({ description: UNCATEGORIZED_DESCRIPTION }),
    needs_review_count: Schema.Int.annotate({ description: "Bank transactions flagged needs_review, including credits, transfers and categorized rows; excludes owed expenses." }),
  }),
  categories: Schema.Array(
    Schema.Struct({
      category: Schema.String.annotate({ description: "Exact category name, or Uncategorized for rows without a category." }),
      net: Schema.String.annotate({
        description: "Same net_self calculation restricted to this category, including owed_expense amounts incurred in the period; transfers contribute zero. Only non-zero category totals are returned. Exact rupee string.",
      }),
      count: Schema.Int.annotate({ description: "Bank transaction rows plus owed_expense rows in this category and period, including credits, transfers and settled owed expenses; split bills count once." }),
    }),
  ),
});
const OverviewStats = Schema.Struct({
  rows: Schema.Int.annotate({ description: "All bank transaction rows, including credits and transfers; excludes owed expenses." }),
  paid: Schema.String.annotate({ description: "Sum of full bank debits, including transfers and split bills. Exact rupee string." }),
  received: Schema.String.annotate({ description: "Sum of full bank credits, including transfers and reimbursements. Exact rupee string." }),
  uncategorized: Schema.Int.annotate({ description: UNCATEGORIZED_DESCRIPTION }),
  split_count: Schema.Int.annotate({ description: "Bank transactions with at least one split, counted once, including credits and transfers; excludes owed expenses." }),
  open_shares: Schema.String.annotate({ description: "Outstanding participant shares on transactions in this period: sum of max(0, expected minus all settlements including writeoffs). Settlements are all-time; includes credits and transfers with splits, excludes owed expenses. Exact rupee string." }),
});
export const OverviewOutput = Schema.Struct({
  first_transaction_date: Schema.NullOr(Schema.String).annotate({ description: "Earliest bank transaction date (YYYY-MM-DD), or null if empty." }),
  last_transaction_date: Schema.NullOr(Schema.String).annotate({ description: "Latest bank transaction date (YYYY-MM-DD), or null if empty." }),
  months: Schema.Array(Schema.Struct({ month: Month, ...OverviewStats.fields })).annotate({ description: "Months containing bank transactions, oldest first. Includes full calendar months." }),
  totals: OverviewStats.annotate({ description: "All-time bank totals and outstanding split shares, with the same definitions as each month." }),
  people: Schema.Array(Schema.Struct({
    name: Schema.String.annotate({ description: "Full person name; historical names are grouped case-insensitively after trimming, like the app's open balances." }),
    owed_to_you: Schema.String.annotate({ description: "All-time outstanding split participant shares in this account after all settlements including writeoffs; excludes owed expenses. Exact rupee string." }),
    you_owe: Schema.String.annotate({ description: "All-time outstanding user-owned owed_expense amounts after all settlements; excludes split shares. Owed expenses belong to the user, not a bank account. Exact rupee string." }),
  })).annotate({ description: "Only people with a non-zero balance in either direction; descending by owed_to_you plus you_owe, then name." }),
});
export type Overview = typeof OverviewOutput.Type;
export type PeriodSummary = typeof SummaryOutput.Type;
// Advertise the row contract while leaving rejection to proposal.ts so one bad row cannot discard the batch.
const DocumentedProposalRow = Schema.Json.check(
  Schema.makeFilter(() => true, {
    toJsonSchema: () => Schema.toJsonSchemaDocument(ProposalRow).schema,
  }),
);
export const ProposeInput = Schema.Struct({
  rows: Schema.Array(DocumentedProposalRow).check(Schema.isBetweenLength(1, 100)).annotate({
    description:
      "Up to 100 category proposals for uncategorized transactions; bad rows are rejected individually with codes.",
  }),
  title: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(60)).annotate({
      description: "Optional short title, at most 60 characters, shown when the owner reviews this draft in Money.",
    }),
  ),
});
export const ProposeOutput = Schema.Struct({
  draft_stored: Schema.Boolean.annotate({
    description: "Whether a pending review draft was stored; no finance data has changed.",
  }),
  accepted: Schema.Int.annotate({ description: "Number of accepted rows included in the draft." }),
  rejected: Schema.Array(ProposalRejection).annotate({
    description: "Rows rejected individually, with their input indexes and rejection codes.",
  }),
  next_step: Schema.String.annotate({
    description: "How the owner can review and apply this draft in Money.",
  }),
});
