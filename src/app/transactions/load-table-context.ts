import "server-only";

import {
  asc,
  desc,
  eq,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { db, schema } from "@/db";
import { buildSplitByTxn } from "@/lib/splits/build-split-by-txn";
import {
  buildExpenseLinks,
  buildReimbursementLinks,
} from "./SplitSettlementLinks";
import type { CategoryOption } from "./RowActions";
import type { ExistingAllocation, ParticipantOption } from "./SettleDialog";
import {
  loadNetEventsByTransactionIds,
  loadOpenPayablesForUser,
} from "@/lib/net-events/load-net-settle-data";
import {
  buildOpenReceivablesFromLedger,
  buildParticipantOptions,
  getAccountSplitLedger,
} from "@/lib/splits/account-split-ledger";
import { loadCounterpartyPersonHints } from "@/lib/people/counterparty-person-hints";

export type TransactionListRow = {
  id: string;
  txnDate: string;
  amountPaise: number;
  drCr: "debit" | "credit";
  channel: string;
  rawDescription: string;
  parsedPurpose: string | null;
  balancePaise: number | null;
  counterpartyId: string | null;
  counterpartyDisplayName: string | null;
  categoryId: string | null;
  isTransfer: boolean;
  needsReview: boolean;
  note: string | null;
};

export type PeriodTxnTotals = {
  debit: number;
  credit: number;
  netSelf: number;
  count: number;
};

/** Period footer stats for the same filter `where` as the table list. */
export async function loadPeriodTxnTotals(
  where: SQL | undefined,
): Promise<PeriodTxnTotals> {
  const [totals] = await db
    .select({
      debit: sql<number>`coalesce(sum(case when ${schema.transactions.drCr} = 'debit' then ${schema.transactions.amountPaise} else 0 end), 0)::bigint`,
      credit: sql<number>`coalesce(sum(case when ${schema.transactions.drCr} = 'credit' then ${schema.transactions.amountPaise} else 0 end), 0)::bigint`,
      netSelf: sql<number>`
        coalesce(sum(
          case
            when ${schema.transactions.isTransfer} = true then 0
            when ${schema.transactions.drCr} = 'debit'
              then coalesce((select ${schema.splits.yourSharePaise} from ${schema.splits} where ${schema.splits.transactionId} = ${schema.transactions.id}), ${schema.transactions.amountPaise})
            when ${schema.transactions.drCr} = 'credit'
              and exists (select 1 from ${schema.settlements} where ${schema.settlements.inflowTransactionId} = ${schema.transactions.id})
              then 0
            when ${schema.transactions.drCr} = 'credit'
              then -1 * ${schema.transactions.amountPaise}
            else 0
          end
        ), 0)::bigint
      `,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.transactions)
    .where(where);

  return {
    debit: Number(totals.debit),
    credit: Number(totals.credit),
    netSelf: Number(totals.netSelf),
    count: totals.count,
  };
}

export async function loadTransactionTableContext(
  accountId: string,
  userId: string,
  where: SQL | undefined,
  options?: { limit?: number },
) {
  const limit = options?.limit ?? 1000;

  // Overlap account-scoped work with the main list query.
  const ledgerPromise = getAccountSplitLedger(accountId);
  const categoriesPromise = db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      kind: schema.categories.kind,
    })
    .from(schema.categories)
    .where(eq(schema.categories.userId, userId))
    .orderBy(asc(schema.categories.kind), asc(schema.categories.name));
  const personsPromise = db
    .select({ name: schema.persons.name })
    .from(schema.persons)
    .where(eq(schema.persons.userId, userId))
    .orderBy(asc(schema.persons.name));
  const payablesPromise = loadOpenPayablesForUser(userId);
  const hintsPromise = loadCounterpartyPersonHints(accountId);

  const rows = await db
    .select({
      id: schema.transactions.id,
      txnDate: schema.transactions.txnDate,
      amountPaise: schema.transactions.amountPaise,
      drCr: schema.transactions.drCr,
      channel: schema.transactions.channel,
      rawDescription: schema.transactions.rawDescription,
      parsedPurpose: schema.transactions.parsedPurpose,
      balancePaise: schema.transactions.balancePaise,
      counterpartyId: schema.transactions.counterpartyId,
      counterpartyDisplayName: schema.counterparties.displayName,
      categoryId: schema.transactions.categoryId,
      isTransfer: schema.transactions.isTransfer,
      needsReview: schema.transactions.needsReview,
      note: schema.transactions.note,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.counterparties,
      eq(schema.transactions.counterpartyId, schema.counterparties.id),
    )
    .where(where)
    .orderBy(
      desc(schema.transactions.txnDate),
      desc(schema.transactions.createdAt),
      sql`(${schema.transactions.rawPayload}->>'serial')::int desc nulls last`,
    )
    .limit(limit);

  const txnIds = rows.map((r) => r.id);

  const [
    splits,
    settlementsForRows,
    ledger,
    categories,
    personRows,
    openPayables,
    counterpartyPersonHints,
    netEventsByTxn,
  ] = await Promise.all([
    txnIds.length
      ? db
          .select()
          .from(schema.splits)
          .where(inArray(schema.splits.transactionId, txnIds))
      : Promise.resolve([] as (typeof schema.splits.$inferSelect)[]),
    txnIds.length
      ? db
          .select()
          .from(schema.settlements)
          .where(inArray(schema.settlements.inflowTransactionId, txnIds))
      : Promise.resolve([] as (typeof schema.settlements.$inferSelect)[]),
    ledgerPromise,
    categoriesPromise,
    personsPromise,
    payablesPromise,
    hintsPromise,
    loadNetEventsByTransactionIds(txnIds),
  ]);

  const splitIds = splits.map((s) => s.id);
  const inflowSettlementIds = settlementsForRows
    .map((s) => s.inflowTransactionId)
    .filter((id): id is string => id != null);

  const expenseTxn = schema.transactions;
  const expenseCp = schema.counterparties;
  const inflowTxn = schema.transactions;

  const participantsAll = splitIds.length
    ? await db
        .select()
        .from(schema.splitParticipants)
        .where(inArray(schema.splitParticipants.splitId, splitIds))
    : [];

  const participantIds = participantsAll.map((p) => p.id);

  const [settlementExpenseRows, reimbursementRows] = await Promise.all([
    inflowSettlementIds.length > 0
      ? db
          .select({
            inflowTransactionId: schema.settlements.inflowTransactionId,
            amountPaise: schema.settlements.amountPaise,
            personName: schema.splitParticipants.personName,
            expenseTransactionId: schema.splits.transactionId,
            expenseTxnDate: expenseTxn.txnDate,
            expenseRawDescription: expenseTxn.rawDescription,
            expenseParsedPurpose: expenseTxn.parsedPurpose,
            expenseCounterpartyDisplayName: expenseCp.displayName,
          })
          .from(schema.settlements)
          .innerJoin(
            schema.splitParticipants,
            eq(
              schema.settlements.splitParticipantId,
              schema.splitParticipants.id,
            ),
          )
          .innerJoin(
            schema.splits,
            eq(schema.splitParticipants.splitId, schema.splits.id),
          )
          .innerJoin(expenseTxn, eq(schema.splits.transactionId, expenseTxn.id))
          .leftJoin(expenseCp, eq(expenseTxn.counterpartyId, expenseCp.id))
          .where(
            inArray(schema.settlements.inflowTransactionId, inflowSettlementIds),
          )
      : Promise.resolve([]),
    participantIds.length > 0
      ? db
          .select({
            splitTransactionId: schema.splits.transactionId,
            inflowTransactionId: schema.settlements.inflowTransactionId,
            amountPaise: schema.settlements.amountPaise,
            personName: schema.splitParticipants.personName,
            inflowTxnDate: inflowTxn.txnDate,
            inflowRawDescription: inflowTxn.rawDescription,
            inflowCounterpartyDisplayName: schema.counterparties.displayName,
          })
          .from(schema.settlements)
          .innerJoin(
            schema.splitParticipants,
            eq(
              schema.settlements.splitParticipantId,
              schema.splitParticipants.id,
            ),
          )
          .innerJoin(
            schema.splits,
            eq(schema.splitParticipants.splitId, schema.splits.id),
          )
          .innerJoin(
            inflowTxn,
            eq(schema.settlements.inflowTransactionId, inflowTxn.id),
          )
          .leftJoin(
            schema.counterparties,
            eq(inflowTxn.counterpartyId, schema.counterparties.id),
          )
          .where(
            inArray(schema.settlements.splitParticipantId, participantIds),
          )
      : Promise.resolve([]),
  ]);

  const expenseLinksByInflow = buildExpenseLinks(settlementExpenseRows);
  const reimbursementsByExpense = buildReimbursementLinks(reimbursementRows);

  const settlementsByInflow = new Map<string, ExistingAllocation[]>();
  for (const st of settlementsForRows) {
    if (!st.inflowTransactionId || !st.splitParticipantId) continue;
    const arr = settlementsByInflow.get(st.inflowTransactionId) ?? [];
    arr.push({
      splitParticipantId: st.splitParticipantId,
      amountPaise: Number(st.amountPaise),
    });
    settlementsByInflow.set(st.inflowTransactionId, arr);
  }

  const splitByTxn = buildSplitByTxn(
    splits,
    participantsAll,
    ledger.settledByParticipant,
  );

  const participantOptions: ParticipantOption[] =
    buildParticipantOptions(ledger);
  const categoryOptions: CategoryOption[] = categories;
  const openReceivables = buildOpenReceivablesFromLedger(ledger);

  return {
    rows,
    splitByTxn,
    settlementsByInflow,
    expenseLinksByInflow,
    reimbursementsByExpense,
    participantOptions,
    categoryOptions,
    knownPersonNames: personRows.map((p) => p.name),
    counterpartyPersonHints,
    openReceivables,
    openPayables,
    netEventsByTxn,
  };
}
