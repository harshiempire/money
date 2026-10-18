import { Schema } from "effect";
import { ProposalRejection, ProposalRow } from "./proposal";
import { TransactionView } from "./view";

export const Month = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/u)).annotate({
  description: "Calendar month in YYYY-MM format.",
});
export const EmptyInput = Schema.Struct({});
export const MonthInput = Schema.Struct({ month: Schema.optionalKey(Month) });
export const ListTransactionsInput = Schema.Struct({
  month: Schema.optionalKey(Month),
  uncategorized: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "When true, return only transactions without a category." }),
  ),
  payee: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(160)).annotate({
      description: "Case-insensitive substring of the redacted payee display name returned by this tool.",
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
});
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
  transactions: Schema.Array(TransactionView).annotate({ description: "One page of redacted transactions." }),
  next_cursor: Schema.NullOr(Schema.String).annotate({
    description: "Opaque cursor for the next page, or null when there are no more results.",
  }),
});
export const NotesOutput = Schema.Struct({
  notes: Schema.Array(Schema.String).annotate({ description: "Safe standing notes written by the owner." }),
  omitted: Schema.Int.annotate({ description: "Number of standing notes omitted by redaction." }),
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
    partial: Schema.Boolean.annotate({ description: "Whether the selected period is incomplete." }),
  }),
  totals: Schema.Struct({
    total_debit: Schema.String.annotate({ description: "Total debits as an exact rupee string." }),
    total_credit: Schema.String.annotate({ description: "Total credits as an exact rupee string." }),
    net_self: Schema.String.annotate({ description: "Net personal spend as an exact rupee string." }),
    owed_self: Schema.String.annotate({
      description: "Recorded owed expenses for this period as an exact rupee string.",
    }),
    count: Schema.Int.annotate({ description: "Number of transactions." }),
  }),
  bridge: Schema.Struct({
    personal_debit_gross: Schema.String.annotate({
      description: "Gross personal debits as an exact rupee string.",
    }),
    your_share_debit: Schema.String.annotate({
      description: "Owner share of debits as an exact rupee string.",
    }),
    others_share: Schema.String.annotate({
      description: "Other people share of debits as an exact rupee string.",
    }),
    net_credit: Schema.String.annotate({
      description: "Non-transfer credits after settlements and owed-back amounts, as an exact rupee string.",
    }),
    split_txn_count: Schema.Int.annotate({ description: "Number of transactions." }),
  }),
  triage: Schema.Struct({
    uncategorized_net_self: Schema.String.annotate({
      description: "Net personal spend as an exact rupee string.",
    }),
    uncategorized_count: Schema.Int.annotate({ description: "Number of transactions." }),
    needs_review_count: Schema.Int.annotate({ description: "Number of transactions." }),
  }),
  categories: Schema.Array(
    Schema.Struct({
      category: Schema.String.annotate({ description: "Safe category name." }),
      net: Schema.String.annotate({
        description: "Net personal spend for this category as an exact rupee string.",
      }),
      count: Schema.Int.annotate({ description: "Number of transactions." }),
    }),
  ),
});
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
    Schema.String.annotate({
      description: "Optional short title shown when the owner reviews this draft in Money.",
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
