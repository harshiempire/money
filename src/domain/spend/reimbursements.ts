import "server-only";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema } from "@/db";

const inflowTxn = alias(schema.transactions, "inflow_txn");

export interface ReimbursementBridgeTotals {
  expectedReimbursePaise: number;
  settledReimbursePaise: number;
  outstandingReimbursePaise: number;
  receivedInPeriodPaise: number;
  splitCount: number;
  openSplitCount: number;
}

export async function reimbursementBridgeTotals(
  accountId: string,
  from: string | null,
  to: string | null,
): Promise<ReimbursementBridgeTotals> {
  const txnFilters = [eq(schema.transactions.accountId, accountId)];
  if (from) txnFilters.push(gte(schema.transactions.txnDate, from));
  if (to) txnFilters.push(lte(schema.transactions.txnDate, to));
  const txnWhere = and(...txnFilters);

  const splitsInPeriod = await db
    .select({ splitId: schema.splits.id })
    .from(schema.splits)
    .innerJoin(
      schema.transactions,
      eq(schema.splits.transactionId, schema.transactions.id),
    )
    .where(txnWhere);

  const splitIds = splitsInPeriod.map((s) => s.splitId);
  const receivedInPeriodPaise = await sumSettlementsReceivedInPeriod(
    accountId,
    from,
    to,
  );

  if (splitIds.length === 0) {
    return {
      expectedReimbursePaise: 0,
      settledReimbursePaise: 0,
      outstandingReimbursePaise: 0,
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

  const settledByParticipant = new Map<string, number>();
  if (participantIds.length > 0) {
    const sets = await db
      .select({
        splitParticipantId: schema.settlements.splitParticipantId,
        amountPaise: schema.settlements.amountPaise,
      })
      .from(schema.settlements)
      .where(inArray(schema.settlements.splitParticipantId, participantIds));
    for (const s of sets) {
      settledByParticipant.set(
        s.splitParticipantId,
        (settledByParticipant.get(s.splitParticipantId) ?? 0) +
          Number(s.amountPaise),
      );
    }
  }

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
