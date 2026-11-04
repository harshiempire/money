import { buildPersonBalances } from "@/lib/ledger/rules/balances";
import { McpToolError } from "./pagination";
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
  personId?: string | null;
  outstandingPaise: number;
}
export interface OpenPayable {
  personName: string;
  personId?: string | null;
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
  const people = buildPersonBalances({ people:[],
    shares:shares.map((s,i) => ({id:String(i),personId:s.personId,personName:s.personName,date:s.txnDate,what:"",amountPaise:Math.max(0,s.outstandingPaise),settledRows:[]})),
    owed:payables.map((p,i) => ({id:String(i),personId:p.personId,personName:p.personName,date:"",what:"",amountPaise:Math.max(0,p.outstandingPaise),settledRows:[]})),
  });
  if (!people) throw new McpToolError("Balance exceeds the exact integer paise range.");
  for (const share of shares) {
    const outstanding = Math.max(0, share.outstandingPaise);
    const stats = months.get(share.txnDate.slice(0, 7));
    if (stats) stats.open_shares += outstanding;
    totals.open_shares += outstanding;

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
    people: people.filter(p => p.openShareCount || p.openOwedCount)
      .sort((a,b) => (b.owedToYouPaise+b.youOwePaise)-(a.owedToYouPaise+a.youOwePaise) || a.name.localeCompare(b.name))
      .map(p => ({name:p.name,owed_to_you:rupees(p.owedToYouPaise),you_owe:rupees(p.youOwePaise)})),
  };
}
