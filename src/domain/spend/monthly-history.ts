import "server-only";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { calendarMonthPeriod, type Period } from "@/lib/period";
import {
  loadBulkMonthlyOwedSelf,
  loadBulkMonthlyTxnMetrics,
} from "./net";
import { loadBulkMonthlyReimburseOutstanding } from "./reimbursements";

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

/** Last N calendar months of spend summary (newest first). */
export async function monthlySpendHistory(
  accountId: string,
  monthCount = 12,
  userId?: string | null,
): Promise<MonthlySpendRow[]> {
  const now = new Date();
  const periods: (Period & { monthKey: string; isPartial: boolean })[] = [];

  for (let i = 0; i < monthCount; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push(calendarMonthPeriod(d.getFullYear(), d.getMonth() + 1));
  }

  const oldestFrom = periods[periods.length - 1].from!;
  const newestTo = periods[0].to!;

  const [txnByMonth, owedByMonth, reimbByMonth] = await Promise.all([
    loadBulkMonthlyTxnMetrics(accountId, oldestFrom, newestTo),
    userId
      ? loadBulkMonthlyOwedSelf(userId, oldestFrom, newestTo)
      : Promise.resolve(new Map<string, number>()),
    loadBulkMonthlyReimburseOutstanding(accountId, oldestFrom, newestTo),
  ]);

  return periods.map((period) => {
    const txn = txnByMonth.get(period.monthKey);
    const owed = owedByMonth.get(period.monthKey) ?? 0;
    return {
      monthKey: period.monthKey,
      label: period.label,
      from: period.from!,
      to: period.to!,
      isPartial: period.isPartial,
      netSelfPaise: (txn?.txnNetSelfPaise ?? 0) + owed,
      yourShareDebitPaise: txn?.yourShareDebitPaise ?? 0,
      othersSharePaise: txn?.othersSharePaise ?? 0,
      outstandingReimbursePaise: reimbByMonth.get(period.monthKey) ?? 0,
    };
  });
}

/** Earliest transaction month through current month for month picker bounds. */
export async function transactionMonthBounds(
  accountId: string,
): Promise<{ earliest: string | null; latest: string }> {
  const [r] = await db
    .select({
      earliest: sql<string>`min(${schema.transactions.txnDate})`,
      latest: sql<string>`max(${schema.transactions.txnDate})`,
    })
    .from(schema.transactions)
    .where(sql`${schema.transactions.accountId} = ${accountId}`);

  const today = new Date();
  const latestMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  return {
    earliest: r.earliest?.slice(0, 7) ?? null,
    latest: r.latest?.slice(0, 7) ?? latestMonth,
  };
}
