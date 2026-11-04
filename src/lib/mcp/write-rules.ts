import { Schema } from "effect";
import { LedgerError } from "@/lib/ledger/context";
import { equalShares } from "@/lib/assistant/card-math";
import { personKey, closePersonNames } from "./person-names";
export { personKey } from "./person-names";

const decimal = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/u;
function exactPaise(value: string | number): bigint | null {
  const text = String(value);
  if (!decimal.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (whole.length > 14) return null;
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? result : null;
}
export const Money = Schema.Union([Schema.String, Schema.Number]).check(
  Schema.makeFilter(value => exactPaise(value) !== null, { expected: "nonnegative decimal rupees with at most two decimals, within exact paise range" }),
).annotate({ description: "Decimal rupee string or number, at most two decimal places; no rounding, signs, commas or exponent strings." });
export const PositiveMoney = Money.check(Schema.makeFilter(value => (exactPaise(value) ?? 0n) > 0n, { expected: "positive rupee amount" }));
export function moneyPaise(value: string | number): number {
  if (!Schema.is(Money)(value)) throw new LedgerError({ code: "invalid_amount", message: "Use decimal rupees with at most two decimal places; no rounding is allowed." });
  return Number(exactPaise(value)!);
}
export const exactRupees = (paise: number | bigint): string => {
  const n = BigInt(paise), sign = n < 0n ? "-" : "", abs = n < 0n ? -n : n;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
};
/**
 * Exact (trimmed, case-insensitive) match, or an explicit new person. A new person is refused while
 * any existing name is close ("Ravi" vs "Ravi Teja") unless distinctFrom lists every close name the
 * owner confirmed is someone else, so a near-miss is never silently created.
 */
export function existingPerson(names: readonly string[], said: string, create = false, distinctFrom: readonly string[] = []): string {
  const found = names.find(name => personKey(name) === personKey(said));
  if (found) return found.trim();
  const close = closePersonNames(names, said);
  if (create && said.trim()) {
    const unconfirmed = close.filter(name => !distinctFrom.some(other => personKey(other) === personKey(name)));
    if (!unconfirmed.length) return said.trim();
    throw new LedgerError({ code: "unknown_person", message: `Not creating '${said.trim()}': it is close to ${unconfirmed.join(", ")}. Ask the owner which person they mean. If it really is a different person, retry with distinct_from listing ${unconfirmed.join(", ")}.` });
  }
  throw new LedgerError({ code: "unknown_person", message: `Unknown person '${said.trim()}'. ${close.length ? `Close names: ${close.join(", ")}.` : "No close names found."} Use an exact name or explicitly set create_person: true where supported.` });
}
export function splitAmounts(total: number, amounts: readonly (string | number | undefined)[], yours: string | number | undefined, equal: boolean) {
  if (equal) {
    if (yours !== undefined || amounts.some(a => a !== undefined)) throw new LedgerError({ code: "invalid_input", message: "Equal splits cannot also specify amounts or your_share." });
    const shares = equalShares(total, amounts.length);
    return { yours: shares.yours, participants: amounts.map(() => shares.each) };
  }
  if (yours === undefined || amounts.some(a => a === undefined)) throw new LedgerError({ code: "invalid_input", message: "Explicit splits require every participant amount and your_share." });
  const participants = amounts.map(a => moneyPaise(a!));
  const owner = moneyPaise(yours);
  const sum = participants.reduce((n, p) => n + BigInt(p), BigInt(owner));
  const gap = BigInt(total) - sum;
  if (gap !== 0n) throw new LedgerError({ code: "split_gap", message: `Shares must equal the payment exactly; ${gap > 0n ? "short by" : "over by"} ₹${exactRupees(gap > 0n ? gap : -gap)}.` });
  return { yours: owner, participants };
}

export { allocateOldestFirst, validateAllocations, type OpenAllocation } from "@/lib/ledger/rules/settlement-policy";
