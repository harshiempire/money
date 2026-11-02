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
export function existingPerson(names: readonly string[], said: string, create = false): string {
  const found = names.find(name => personKey(name) === personKey(said));
  if (found) return found.trim();
  if (create && said.trim()) return said.trim();
  const close = closePersonNames(names, said);
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

export interface OpenAllocation { id: string; date: string; order: string; leftPaise: number }
/** Stable oldest bill first, then split creation order, then participant id. */
export function allocateOldestFirst(available: number, shares: readonly OpenAllocation[]) {
  let remaining = available;
  const allocations: Array<{ id: string; amountPaise: number; leftPaise: number }> = [];
  for (const share of [...shares].sort((a, b) => a.date.localeCompare(b.date) || a.order.localeCompare(b.order) || a.id.localeCompare(b.id))) {
    const amountPaise = Math.min(remaining, share.leftPaise);
    if (amountPaise <= 0) continue;
    allocations.push({ id: share.id, amountPaise, leftPaise: share.leftPaise - amountPaise });
    remaining -= amountPaise;
  }
  return { allocations, remaining };
}
export function validateAllocations(available: number, open: readonly OpenAllocation[], requested: readonly { id: string; amountPaise: number }[]) {
  const totals = new Map<string, bigint>();
  for (const row of requested) {
    if (!Number.isSafeInteger(row.amountPaise) || row.amountPaise <= 0) throw new LedgerError({ code: "invalid_amount", message: "Allocations must be positive exact paise." });
    totals.set(row.id, (totals.get(row.id) ?? 0n) + BigInt(row.amountPaise));
  }
  const allocations = [...totals].map(([id, amount]) => {
    const share = open.find(s => s.id === id);
    if (!share) throw new LedgerError({ code: "not_found", message: "That share isn't available for this person." });
    if (amount > BigInt(share.leftPaise)) throw new LedgerError({ code: "over_allocation", message: `Allocation ₹${exactRupees(amount)} exceeds a share's outstanding ₹${exactRupees(share.leftPaise)}.` });
    const amountPaise = Number(amount);
    return { id, amountPaise, leftPaise: share.leftPaise - amountPaise };
  });
  const used = allocations.reduce((sum, a) => sum + BigInt(a.amountPaise), 0n);
  if (used > BigInt(available)) throw new LedgerError({ code: "over_allocation", message: `Allocations exceed the inflow's unallocated ₹${exactRupees(available)}.` });
  return { allocations, remaining: available - Number(used) };
}
