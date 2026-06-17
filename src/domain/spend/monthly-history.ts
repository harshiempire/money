import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { calendarMonthPeriod, type Period } from "@/lib/period";
import {
  netSpendTotals,
  splitBridgeTotals,
  type NetSpendTotals,
  type SplitBridgeTotals,
} from "./net";
import { reimbursementBridgeTotals } from "./reimbursements";

export interface MonthlySpendRow {
  monthKey: string;
  label: string;
  from: string;
  to: string;
  isPartial: boolean;
  netSelfPaise: number;
  yourShareDebitPaise: number;
  othersSharePaise: number;
  outstandingReimbursePaise: number;
}

export async function monthlySpendHistory(
  accountIds: string[],
  userId: string,
  monthCount = 12,
): Promise<MonthlySpendRow[]> {
  const now = new Date();
  const rows: MonthlySpendRow[] = [];

  for (let i = 0; i < monthCount; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const period = calendarMonthPeriod(d.getFullYear(), d.getMonth() + 1);
    const [totals, bridge, reimb] = await Promise.all([
      netSpendTotals(accountIds, period.from, period.to, userId),
      splitBridgeTotals(accountIds, period.from, period.to),
      reimbursementBridgeTotals(accountIds, userId, period.from, period.to),
    ]);
    rows.push(buildMonthlyRow(period, totals, bridge, reimb));
  }

  return rows;
}

function buildMonthlyRow(
  period: Period & { monthKey: string; isPartial: boolean },
  totals: NetSpendTotals,
  bridge: SplitBridgeTotals,
  reimb: { outstandingReimbursePaise: number },
): MonthlySpendRow {
  return {
    monthKey: period.monthKey,
    label: period.label,
    from: period.from!,
    to: period.to!,
    isPartial: period.isPartial,
    netSelfPaise: totals.netSelfPaise,
    yourShareDebitPaise: bridge.yourShareDebitPaise,
    othersSharePaise: bridge.othersSharePaise,
    outstandingReimbursePaise: reimb.outstandingReimbursePaise,
  };
}

export async function transactionMonthBounds(
  accountIds: string[],
): Promise<{ earliest: string | null; latest: string }> {
  if (accountIds.length === 0) {
    const today = new Date();
    return { earliest: null, latest: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}` };
  }
  const [r] = await db
    .select({
      earliest: sql<string>`min(${schema.transactions.txnDate})`,
      latest: sql<string>`max(${schema.transactions.txnDate})`,
    })
    .from(schema.transactions)
    .where(inArray(schema.transactions.accountId, accountIds));

  const today = new Date();
  const latestMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  return {
    earliest: r.earliest?.slice(0, 7) ?? null,
    latest: r.latest?.slice(0, 7) ?? latestMonth,
  };
}
