import "server-only";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema } from "@/db";
import { txnMonthKeyExpr } from "@/domain/spend/net";
import {
  settledAmountByOwedExpenseIds,
  settledAmountByParticipantIds,
} from "@/lib/splits/outstanding";

const inflowTxn = alias(schema.transactions, "inflow_txn");

export interface ReimbursementBridgeTotals {
  expectedReimbursePaise: number;
  settledReimbursePaise: number;
  outstandingReimbursePaise: number;
  outstandingPayablePaise: number;
  receivedInPeriodPaise: number;
  splitCount: number;
  openSplitCount: number;
}

export async function reimbursementBridgeTotals(
  accountId: string,
  from: string | null,
  to: string | null,
  userId?: string | null,
): Promise<ReimbursementBridgeTotals> {
  const txnFilters = [eq(schema.transactions.accountId, accountId)];
  if (from) txnFilters.push(gte(schema.transactions.txnDate, from));
  if (to) txnFilters.push(lte(schema.transactions.txnDate, to));
  const txnWhere = and(...txnFilters);

  const resolvedUserId =
    userId ??
    (
      await db
        .select({ userId: schema.moneyAccounts.userId })
        .from(schema.moneyAccounts)
        .where(eq(schema.moneyAccounts.id, accountId))
        .limit(1)
    )[0]?.userId;

  const [splitsInPeriod, receivedInPeriodPaise] = await Promise.all([
    db
      .select({ splitId: schema.splits.id })
      .from(schema.splits)
      .innerJoin(
        schema.transactions,
        eq(schema.splits.transactionId, schema.transactions.id),
      )
      .where(txnWhere),
    sumSettlementsReceivedInPeriod(accountId, from, to),
  ]);

  const splitIds = splitsInPeriod.map((s) => s.splitId);

  let outstandingPayablePaise = 0;
  if (resolvedUserId) {
    const owedFilters = [eq(schema.owedExpenses.userId, resolvedUserId)];
    if (from) owedFilters.push(gte(schema.owedExpenses.incurredDate, from));
    if (to) owedFilters.push(lte(schema.owedExpenses.incurredDate, to));

    const owedInPeriod = await db
      .select({
        id: schema.owedExpenses.id,
        amountPaise: schema.owedExpenses.amountPaise,
      })
      .from(schema.owedExpenses)
      .where(and(...owedFilters));

    if (owedInPeriod.length > 0) {
      const settled = await settledAmountByOwedExpenseIds(
        owedInPeriod.map((o) => o.id),
      );
      for (const o of owedInPeriod) {
        const expected = Number(o.amountPaise);
        const paid = settled.get(o.id) ?? 0;
        outstandingPayablePaise += Math.max(0, expected - paid);
      }
    }
  }

  if (splitIds.length === 0) {
    return {
      expectedReimbursePaise: 0,
      settledReimbursePaise: 0,
      outstandingReimbursePaise: 0,
      outstandingPayablePaise,
      receivedInPeriodPaise,
      splitCount: 0,
      openSplitCount: 0,
    };
  }

  const partsWithSplit = await db
    .select({
      splitId: schema.splitParticipants.splitId,
      participantId: schema.splitParticipants.id,
      expectedAmountPaise: schema.splitParticipants.expectedAmountPaise,
    })
    .from(schema.splitParticipants)
    .where(inArray(schema.splitParticipants.splitId, splitIds));

  const participantIds = partsWithSplit.map((p) => p.participantId);
  const expectedReimbursePaise = partsWithSplit.reduce(
    (s, p) => s + Number(p.expectedAmountPaise),
    0,
  );

  const settledByParticipant =
    participantIds.length > 0
      ? await settledAmountByParticipantIds(participantIds)
      : new Map<string, number>();

  let settledReimbursePaise = 0;
  const openSplitIds = new Set<string>();
  for (const p of partsWithSplit) {
    const settled = settledByParticipant.get(p.participantId) ?? 0;
    settledReimbursePaise += settled;
    if (settled < Number(p.expectedAmountPaise)) {
      openSplitIds.add(p.splitId);
    }
  }

  return {
    expectedReimbursePaise,
    settledReimbursePaise,
    outstandingReimbursePaise: Math.max(
      0,
      expectedReimbursePaise - settledReimbursePaise,
    ),
    outstandingPayablePaise,
    receivedInPeriodPaise,
    splitCount: splitIds.length,
    openSplitCount: openSplitIds.size,
  };
}

async function sumSettlementsReceivedInPeriod(
  accountId: string,
  from: string | null,
  to: string | null,
): Promise<number> {
  if (!from || !to) return 0;

  const expenseTxn = schema.transactions;

  const [bank] = await db
    .select({
      total: sql<number>`coalesce(sum(${schema.settlements.amountPaise}), 0)::bigint`,
    })
    .from(schema.settlements)
    .innerJoin(
      schema.splitParticipants,
      eq(schema.settlements.splitParticipantId, schema.splitParticipants.id),
    )
    .innerJoin(
      schema.splits,
      eq(schema.splitParticipants.splitId, schema.splits.id),
    )
    .innerJoin(expenseTxn, eq(schema.splits.transactionId, expenseTxn.id))
    .innerJoin(
      inflowTxn,
      eq(schema.settlements.inflowTransactionId, inflowTxn.id),
    )
    .where(
      and(
        eq(expenseTxn.accountId, accountId),
        eq(schema.settlements.method, "bank"),
        gte(inflowTxn.txnDate, from),
        lte(inflowTxn.txnDate, to),
      ),
    );

  const [cash] = await db
    .select({
      total: sql<number>`coalesce(sum(${schema.settlements.amountPaise}), 0)::bigint`,
    })
    .from(schema.settlements)
    .innerJoin(
      schema.splitParticipants,
      eq(schema.settlements.splitParticipantId, schema.splitParticipants.id),
    )
    .innerJoin(
      schema.splits,
      eq(schema.splitParticipants.splitId, schema.splits.id),
    )
    .innerJoin(expenseTxn, eq(schema.splits.transactionId, expenseTxn.id))
    .where(
      and(
        eq(expenseTxn.accountId, accountId),
        eq(schema.settlements.method, "cash"),
        sql`${schema.settlements.createdAt}::date >= ${from}::date`,
        sql`${schema.settlements.createdAt}::date <= ${to}::date`,
      ),
    );

  return Number(bank.total) + Number(cash.total);
}

/** Outstanding split reimbursements grouped by expense month (one bulk query). */
export async function loadBulkMonthlyReimburseOutstanding(
  accountId: string,
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const txnWhere = and(
    eq(schema.transactions.accountId, accountId),
    gte(schema.transactions.txnDate, from),
    lte(schema.transactions.txnDate, to),
  );

  const rows = await db
    .select({
      monthKey: txnMonthKeyExpr,
      participantId: schema.splitParticipants.id,
      expectedAmountPaise: schema.splitParticipants.expectedAmountPaise,
    })
    .from(schema.splits)
    .innerJoin(
      schema.transactions,
      eq(schema.splits.transactionId, schema.transactions.id),
    )
    .innerJoin(
      schema.splitParticipants,
      eq(schema.splitParticipants.splitId, schema.splits.id),
    )
    .where(txnWhere);

  if (rows.length === 0) return new Map();

  const settled = await settledAmountByParticipantIds(
    rows.map((r) => r.participantId),
  );

  const byMonth = new Map<string, { expected: number; settled: number }>();
  for (const r of rows) {
    const entry = byMonth.get(r.monthKey) ?? { expected: 0, settled: 0 };
    entry.expected += Number(r.expectedAmountPaise);
    entry.settled += settled.get(r.participantId) ?? 0;
    byMonth.set(r.monthKey, entry);
  }

  const result = new Map<string, number>();
  for (const [monthKey, { expected, settled: settledAmt }] of byMonth) {
    result.set(monthKey, Math.max(0, expected - settledAmt));
  }
  return result;
}
