/**
 * What the model may see about a transaction. The owner agreed to share
 * amounts, dates, merchant names and their own notes — not UPI ids, phone
 * numbers, account numbers, bank reference ids or balances.
 */

const LONG_DIGITS = /\d{5,}/;

/** Ingest copies a UPI key into displayName; only an owner rename is a name. */
export function userChosenDisplayName(input: {
  kind: string | null;
  key: string | null;
  displayName: string | null;
}): string | null {
  const normalize = (value: string) => value.replace(/\s/g, "").toLowerCase();
  if (input.kind === "upi_handle" &&
      (!input.key || normalize(input.displayName ?? "") === normalize(input.key))) return null;
  return input.displayName;
}

/**
 * Text the model may see: the user's own words, with UPI handles and long
 * digit runs (phones, account numbers, reference ids) removed entirely.
 * A note that fails is omitted, not partially redacted.
 */
export function modelSafeText(value: string | null | undefined, max = 160): string | null {
  const t = value?.replace(/\s+/g, " ").trim();
  if (!t || t.length < 2 || t.includes("@") || LONG_DIGITS.test(t)) return null;
  return t.slice(0, max);
}

/**
 * A payee name safe to send: your display name for them → the payment
 * purpose → a bank payee name (NEFT/IMPS). Never a UPI handle or any part of
 * one, and nothing with a long digit run (phone/account numbers).
 */
export function modelSafePayee(input: {
  counterpartyDisplayName: string | null;
  parsedPurpose: string | null;
  label: string;
}): string {
  const safe = (v: string | null | undefined) => {
    const t = v?.trim();
    if (!t || t.length < 2 || t.includes("@") || LONG_DIGITS.test(t)) return null;
    // A PDF line break can strip the @suffix from a UPI handle.
    if (!/\s/.test(t) && t === t.toLowerCase() && /[._\d-]/.test(t)) return null;
    return t.slice(0, 40);
  };
  return safe(input.counterpartyDisplayName) ?? safe(input.parsedPurpose) ?? safe(input.label) ?? "Payee";
}

export const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const modelDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTH_ABBR[m - 1]} ${y}`;
};

export const modelAmount = (paise: number) =>
  `₹${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paise / 100)}`;
