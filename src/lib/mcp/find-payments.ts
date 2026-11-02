import { Schema } from "effect";
import { FindPaymentsInput } from "./read-schemas";
import { personKey, type McpReadView } from "./model-view";

/** Parse a validated rupee string without floating-point money arithmetic. */
export function amountPaise(value: string): number {
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  const result = Number(amount);
  if (!Number.isSafeInteger(result)) throw new Error("Amount exceeds exact paise range.");
  return result;
}
const dayNumber = (date: string) => Date.parse(date + "T00:00:00Z") / 86_400_000;

/** Pure ranking. Every supplied search signal must match; date/direction are hard bounds. */
export function findPayments(view: McpReadView, rawInput: FindPaymentsInput) {
  const input = Schema.decodeUnknownSync(FindPaymentsInput)(rawInput);
  const target = input.amount ? amountPaise(input.amount) : undefined;
  const text = input.text?.trim().toLowerCase();
  const person = input.person ? personKey(input.person) : undefined;
  const known = person ? view.people.find((p) => personKey(p.name) === person) : undefined;
  const seenKeys = new Set(known?.seen_handles.map((h) => h.key) ?? []);
  const candidates = view.transactions.flatMap((txn) => {
    if (input.direction && txn.direction !== input.direction) return [];
    if (input.from && txn.date < input.from || input.to && txn.date > input.to) return [];
    const distance = input.date ? Math.abs(dayNumber(txn.date) - dayNumber(input.date)) : undefined;
    if (distance !== undefined && !input.from && !input.to && distance > 7) return [];
    let score = 0;
    const reasons: string[] = [];
    if (target !== undefined) {
      const amount = amountPaise(txn.amount);
      const matchedShares = txn.split?.shares.filter((s) => amountPaise(s.expected) === target) ?? [];
      if (amount === target) { score += 100; reasons.push("exact amount"); }
      else if (matchedShares.length) { score += 90; reasons.push(...matchedShares.map((s) => `exact share amount for ${s.person}`)); }
      else if (BigInt(Math.abs(amount - target)) * 100n <= BigInt(target) * 2n) { score += 50; reasons.push("amount within ±2%"); }
      else return [];
    }
    if (distance !== undefined) {
      score += Math.max(0, 21 - distance * 3);
      reasons.push(distance === 0 ? `exact date ${input.date}` : `${distance} day${distance === 1 ? "" : "s"} from ${input.date}`);
    }
    if (text) {
      const matches = [
        ["payee", txn.payee], ["handle", txn.handle], ["raw description", txn.raw_description], ["note", txn.note],
      ].filter(([, value]) => value?.toLowerCase().includes(text)).map(([field]) => field);
      if (!matches.length) return [];
      score += 30; reasons.push(...matches.map((field) => `${field} matches '${input.text!.trim()}'`));
    }
    if (person) {
      const signals: string[] = [];
      if (txn.split?.shares.some((s) => personKey(s.person) === person)) signals.push(`has a split with ${known?.name ?? input.person!.trim()}`);
      if (txn.note?.toLowerCase().includes(person)) signals.push(`note mentions ${known?.name ?? input.person!.trim()}`);
      if (seenKeys.has(view.transactionKeys.get(txn.ref) ?? "")) signals.push(`handle seen settling ${known!.name}'s shares or owed expenses`);
      if (!signals.length) return [];
      score += 35 + (signals.length - 1) * 5; reasons.push(...signals);
    }
    const { split, settles: _settles, net_event: _event, owed_expenses: _owed, ...base } = txn;
    return [{ ...base, score, reasons, split_summary: split ? { total: split.total, your_share: split.your_share, shares: split.shares.map((s) => ({ person: s.person, expected: s.expected, left: s.left })) } : null }];
  }).sort((a, b) => b.score - a.score || b.date.localeCompare(a.date) || a.ref.localeCompare(b.ref));
  return { candidates: candidates.slice(0, input.limit ?? 10) };
}
