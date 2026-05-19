import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { db, schema } from "@/db";
import { counterpartyLabel, formatDate } from "@/lib/format";
import {
  buildExpenseLinks,
  buildReimbursementLinks,
} from "./SplitSettlementLinks";
import type { CategoryOption } from "./RowActions";
import type { ExistingSplit } from "./SplitDialog";
import type { ExistingAllocation, ParticipantOption } from "./SettleDialog";

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

export async function loadTransactionTableContext(
  accountId: string,
  userId: string,
  where: SQL | undefined,
  options?: { limit?: number },
) {
  const limit = options?.limit ?? 1000;

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
  const splits = txnIds.length
    ? await db
        .select()
        .from(schema.splits)
        .where(inArray(schema.splits.transactionId, txnIds))
    : [];
  const splitIds = splits.map((s) => s.id);
  const participantsAll = splitIds.length
    ? await db
        .select()
        .from(schema.splitParticipants)
        .where(inArray(schema.splitParticipants.splitId, splitIds))
    : [];
  const settlementsForRows = txnIds.length
    ? await db
        .select()
        .from(schema.settlements)
        .where(inArray(schema.settlements.inflowTransactionId, txnIds))
    : [];

  const expenseTxn = schema.transactions;
  const expenseCp = schema.counterparties;
  const inflowTxn = schema.transactions;

  const settlementExpenseRows =
    settlementsForRows.length > 0
      ? await db
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
            inArray(
              schema.settlements.inflowTransactionId,
              settlementsForRows
                .map((s) => s.inflowTransactionId)
                .filter((id): id is string => id != null),
            ),
          )
      : [];

  const participantIds = participantsAll.map((p) => p.id);
  const reimbursementRows =
    participantIds.length > 0
      ? await db
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
      : [];

  const expenseLinksByInflow = buildExpenseLinks(settlementExpenseRows);
  const reimbursementsByExpense = buildReimbursementLinks(reimbursementRows);

  const splitByTxn = new Map<string, ExistingSplit>();
  for (const s of splits) {
    splitByTxn.set(s.transactionId, {
      totalPaise: Number(s.totalPaise),
      yourSharePaise: Number(s.yourSharePaise),
      note: s.note,
      participants: participantsAll
        .filter((p) => p.splitId === s.id)
        .map((p) => ({
          id: p.id,
          personName: p.personName,
          expectedAmountPaise: Number(p.expectedAmountPaise),
        })),
    });
  }

  const settlementsByInflow = new Map<string, ExistingAllocation[]>();
  for (const st of settlementsForRows) {
    if (!st.inflowTransactionId) continue;
    const arr = settlementsByInflow.get(st.inflowTransactionId) ?? [];
    arr.push({
      splitParticipantId: st.splitParticipantId,
      amountPaise: Number(st.amountPaise),
    });
    settlementsByInflow.set(st.inflowTransactionId, arr);
  }

  const allSplitsForAccount = await db
    .select({
      id: schema.splits.id,
      transactionId: schema.splits.transactionId,
      txnDate: schema.transactions.txnDate,
      rawDescription: schema.transactions.rawDescription,
    })
    .from(schema.splits)
    .innerJoin(
      schema.transactions,
      eq(schema.splits.transactionId, schema.transactions.id),
    )
    .where(eq(schema.transactions.accountId, accountId));

  const allParticipants = allSplitsForAccount.length
    ? await db
        .select()
        .from(schema.splitParticipants)
        .where(
          inArray(
            schema.splitParticipants.splitId,
            allSplitsForAccount.map((s) => s.id),
          ),
        )
    : [];

  const allSettlements = allSplitsForAccount.length
    ? await db
        .select({
          splitParticipantId: schema.settlements.splitParticipantId,
          amountPaise: schema.settlements.amountPaise,
        })
        .from(schema.settlements)
        .where(
          inArray(
            schema.settlements.splitParticipantId,
            allParticipants.map((p) => p.id),
          ),
        )
    : [];

  const settledByParticipant = new Map<string, number>();
  for (const s of allSettlements) {
    settledByParticipant.set(
      s.splitParticipantId,
      (settledByParticipant.get(s.splitParticipantId) ?? 0) +
        Number(s.amountPaise),
    );
  }

  const splitMetaById = new Map(allSplitsForAccount.map((s) => [s.id, s]));
  const participantOptions: ParticipantOption[] = allParticipants.map((p) => {
    const meta = splitMetaById.get(p.splitId)!;
    return {
      id: p.id,
      personName: p.personName,
      expectedAmountPaise: Number(p.expectedAmountPaise),
      splitTransactionDate: formatDate(meta.txnDate),
      splitTransactionDescription:
        counterpartyLabel(meta.rawDescription) ?? meta.rawDescription,
      alreadySettledPaise: settledByParticipant.get(p.id) ?? 0,
    };
  });

  const categories = await db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      kind: schema.categories.kind,
    })
    .from(schema.categories)
    .where(eq(schema.categories.userId, userId))
    .orderBy(asc(schema.categories.kind), asc(schema.categories.name));

  const categoryOptions: CategoryOption[] = categories;

  const personRows = await db
    .select({ name: schema.persons.name })
    .from(schema.persons)
    .where(eq(schema.persons.userId, userId))
    .orderBy(asc(schema.persons.name));

  return {
    rows,
    splitByTxn,
    settlementsByInflow,
    expenseLinksByInflow,
    reimbursementsByExpense,
    participantOptions,
    categoryOptions,
    knownPersonNames: personRows.map((p) => p.name),
  };
}
