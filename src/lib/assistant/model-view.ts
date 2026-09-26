/**
 * What the model may see about a transaction. The owner agreed to share
 * amounts, dates, merchant names and their own notes — not UPI ids, phone
 * numbers, account numbers, bank reference ids or balances.
 */

const LONG_DIGITS = /\d{5,}/;

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
    return t && t.length > 1 && !t.includes("@") && !LONG_DIGITS.test(t) ? t.slice(0, 40) : null;
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
