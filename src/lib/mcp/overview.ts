import { isUncategorized } from "@/domain/spend/uncategorized";
import type { Overview } from "./schemas";
import { rupees } from "./view";

export interface OverviewTransaction {
  txnDate: string;
  amountPaise: number;
  drCr: "debit" | "credit";
  categoryId: string | null;
  hasSplit: boolean;
}
export interface OpenShare {
  txnDate: string;
  personName: string;
  outstandingPaise: number;
}
export interface OpenPayable {
  personName: string;
  outstandingPaise: number;
}

export function buildOverview(
  transactions: readonly OverviewTransaction[],
  shares: readonly OpenShare[],
  payables: readonly OpenPayable[],
): Overview {
  const empty = () => ({ rows: 0, paid: 0, received: 0, uncategorized: 0, split_count: 0, open_shares: 0 });
  const months = new Map<string, ReturnType<typeof empty>>();
  const totals = empty();
  const dates = transactions.map((row) => row.txnDate.slice(0, 10)).sort();
  for (const row of transactions) {
    const date = row.txnDate.slice(0, 10);
    const month = date.slice(0, 7);
    const stats = months.get(month) ?? empty();
    for (const target of [stats, totals]) {
      target.rows++;
      target[row.drCr === "debit" ? "paid" : "received"] += row.amountPaise;
      if (isUncategorized(row)) target.uncategorized++;
      if (row.hasSplit) target.split_count++;
    }
    months.set(month, stats);
  }
  const people = new Map<string, { name: string; owed_to_you: number; you_owe: number }>();
  const person = (name: string) => {
    const key = name.trim().toLowerCase();
    const found = people.get(key) ?? { name, owed_to_you: 0, you_owe: 0 };
    people.set(key, found);
    return found;
  };
  for (const share of shares) {
    const outstanding = Math.max(0, share.outstandingPaise);
    const stats = months.get(share.txnDate.slice(0, 7));
    if (stats) stats.open_shares += outstanding;
    totals.open_shares += outstanding;
    if (outstanding) person(share.personName).owed_to_you += outstanding;
  }
  for (const payable of payables) {
    if (payable.outstandingPaise > 0) person(payable.personName).you_owe += payable.outstandingPaise;
  }
  const render = (stats: ReturnType<typeof empty>) => ({
    ...stats,
    paid: rupees(stats.paid),
    received: rupees(stats.received),
    open_shares: rupees(stats.open_shares),
  });
  return {
    first_transaction_date: dates[0] ?? null,
    last_transaction_date: dates.at(-1) ?? null,
    months: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, stats]) => ({ month, ...render(stats) })),
    totals: render(totals),
    people: [...people.values()]
      .sort((a, b) => (b.owed_to_you + b.you_owe) - (a.owed_to_you + a.you_owe) || a.name.localeCompare(b.name))
      .map((p) => ({ name: p.name, owed_to_you: rupees(p.owed_to_you), you_owe: rupees(p.you_owe) })),
  };
}
