import { Data } from "effect";

/**
 * The unified shape that every bank adapter outputs. Everything downstream
 * (dedup, categorization, reports) only sees this — bank-specific quirks live
 * inside the adapter.
 *
 * Money is in paise (integer) to dodge float drift. Dates are ISO strings
 * (YYYY-MM-DD) for round-trip safety with Postgres `date` columns.
 */
export type Channel =
  | "upi"
  | "imps"
  | "neft"
  | "rtgs"
  | "cheque"
  | "cash"
  | "card"
  | "opening"
  | "other";

export type DrCr = "debit" | "credit";

export interface CanonicalTxn {
  /** Date the transaction was initiated (per the statement). */
  txnDate: string; // YYYY-MM-DD
  valueDate: string | null;
  /** Absolute amount in paise. Sign carried by `drCr`. */
  amountPaise: number;
  drCr: DrCr;
  channel: Channel;
  refId: string | null;
  rawDescription: string;
  parsedPurpose: string | null;
  counterpartyKey: string | null;
  balancePaise: number | null;
  /** Anything bank-specific the adapter wants to keep around for forensics. */
  rawPayload: Record<string, unknown>;
}

export interface StatementMeta {
  bank: string;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface ParsedStatement {
  meta: StatementMeta;
  rows: CanonicalTxn[];
}

export class AdapterNotFound extends Data.TaggedError("AdapterNotFound")<{
  readonly mime: string;
  readonly hint: string;
}> {}

export class ParseError extends Data.TaggedError("ParseError")<{
  readonly bank: string;
  readonly stage: string;
  readonly detail: string;
}> {}

export class PdfPasswordError extends Data.TaggedError("PdfPasswordError")<{
  readonly reason: "required" | "incorrect";
}> {}

export class DedupeConflict extends Data.TaggedError("DedupeConflict")<{
  readonly refId: string;
  readonly reason: string;
}> {}

export class PersistError extends Data.TaggedError("PersistError")<{
  readonly cause: unknown;
}> {}
