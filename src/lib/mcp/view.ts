import { Schema } from "effect";

export interface McpTransaction {
  id: string;
  txnDate: string;
  amountPaise: number;
  drCr: "debit" | "credit";
  channel: string;
  displayName: string | null;
  parsedPurpose: string | null;
  label: string;
  counterpartyKey: string | null;
  counterpartyKind: string | null;
  rawDescription: string;
  note: string | null;
  category: string | null;
  defaultCategory?: string | null;
  person?: string | null;
  categoryId: string | null;
  needsReview: boolean;
  isTransfer: boolean;
}

export const TransactionView = Schema.Struct({
  person: Schema.NullOr(Schema.String).annotate({ description: "Confirmed person linked to this payee, or null; learned suggestions are not links." }),
  ref: Schema.String.annotate({
    description: "Opaque account-bound reference for proposals; not a database id.",
  }),
  rev: Schema.String.annotate({ description: "Opaque revision of all editable fields; use it to guard writes." }),
  needs_review: Schema.Boolean.annotate({ description: "Whether the transaction needs review." }),
  date: Schema.String.annotate({ description: "Transaction date in YYYY-MM-DD format." }),
  amount: Schema.String.annotate({
    description: "Exact rupee amount as a decimal string with two fractional digits.",
  }),
  direction: Schema.Literals(["paid", "received"]).annotate({
    description: "Whether money was paid or received.",
  }),
  channel: Schema.String.annotate({ description: "Payment channel." }),
  payee: Schema.String.annotate({ description: "Counterparty display name, else parsed purpose, else counterparty key, else bank label." }),
  handle: Schema.NullOr(Schema.String).annotate({ description: "Counterparty key when its kind is a UPI handle; otherwise null." }),
  raw_description: Schema.String.annotate({ description: "Full raw bank description, including bank references and handles." }),
  purpose: Schema.NullOr(Schema.String).annotate({ description: "Bank parsed_purpose. The bank truncates the owner's UPI remarks to 1–4 letters; do not infer meaning from it." }),
  note: Schema.NullOr(Schema.String).annotate({ description: "Full user note, or null when absent." }),
  category: Schema.NullOr(Schema.String).annotate({
    description: "Category name, or null when absent.",
  }),
  payee_default: Schema.NullOr(Schema.String).annotate({ description: "Current payee default category name, or null when absent. Use as current_default when confirming replacement." }),
  transfer: Schema.Boolean.annotate({ description: "Whether the transaction is marked as a transfer." }),
});
export type TransactionView = typeof TransactionView.Type;

export function rupees(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new Error("That amount isn't available as exact paise.");
  const value = BigInt(paise);
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

export function transactionView(row: McpTransaction, ref: string, rev: string): TransactionView {
  return {
    ref,
    rev,
    person: row.person ?? null,
    needs_review: row.needsReview,
    date: row.txnDate.slice(0, 10),
    amount: rupees(row.amountPaise),
    direction: row.drCr === "debit" ? "paid" : "received",
    channel: row.channel,
    payee: row.displayName ?? row.parsedPurpose ?? row.counterpartyKey ?? row.label,
    handle: row.counterpartyKind === "upi_handle" ? row.counterpartyKey : null,
    raw_description: row.rawDescription,
    purpose: row.parsedPurpose,
    note: row.note,
    category: row.category,
    payee_default: row.defaultCategory ?? null,
    transfer: row.isTransfer,
  };
}
