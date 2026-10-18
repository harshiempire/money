import { Schema } from "effect";
import { counterpartyLabel } from "@/lib/format";
import { modelSafePayee, modelSafeText } from "@/lib/assistant/model-view";

export interface McpTransaction {
  id: string;
  txnDate: string;
  amountPaise: number;
  drCr: "debit" | "credit";
  channel: string;
  displayName: string | null;
  parsedPurpose: string | null;
  label: string;
  note: string | null;
  category: string | null;
  isTransfer: boolean;
}

export const TransactionView = Schema.Struct({
  ref: Schema.String.annotate({
    description: "Opaque account-bound reference for proposals; not a database id.",
  }),
  date: Schema.String.annotate({ description: "Transaction date in YYYY-MM-DD format." }),
  amount: Schema.String.annotate({
    description: "Exact rupee amount as a decimal string with two fractional digits.",
  }),
  direction: Schema.Literals(["paid", "received"]).annotate({
    description: "Whether money was paid or received.",
  }),
  channel: Schema.String.annotate({ description: "Payment channel, with unsafe text omitted." }),
  payee: Schema.String.annotate({ description: "Redacted payee display name; never a UPI handle." }),
  note: Schema.NullOr(Schema.String).annotate({ description: "User note, or null when absent or unsafe." }),
  category: Schema.NullOr(Schema.String).annotate({
    description: "Category name, or null when absent or unsafe.",
  }),
  transfer: Schema.Boolean.annotate({ description: "Whether the transaction is marked as a transfer." }),
});
export type TransactionView = typeof TransactionView.Type;

export function rupees(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new Error("That amount isn't available as exact paise.");
  const value = BigInt(paise);
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

export function transactionView(row: McpTransaction, ref: string): TransactionView {
  return {
    ref,
    date: row.txnDate.slice(0, 10),
    amount: rupees(row.amountPaise),
    direction: row.drCr === "debit" ? "paid" : "received",
    channel: modelSafeText(row.channel) ?? "other",
    payee: modelSafePayee({
      counterpartyDisplayName: row.displayName,
      parsedPurpose: row.parsedPurpose,
      label: row.label,
    }),
    note: modelSafeText(row.note),
    category: modelSafeText(row.category, row.category?.length),
    transfer: row.isTransfer,
  };
}

export function validatePayeeFilter(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = modelSafeText(value);
  if (!safe) throw new Error("Use a payee name without a handle or a number with five or more digits.");
  return safe.toLowerCase();
}

export function bankPayeeLabel(rawDescription: string): string {
  // Only NEFT/IMPS carry bank payee names. A wrapped UPI handle can lose its @ during extraction.
  if (!/^(?:NEFT-|IMPS\/)/.test(rawDescription)) return "Payee";
  const label = counterpartyLabel(rawDescription);
  return rawDescription.startsWith(label.replace(/…$/, "")) ? "Payee" : label;
}
