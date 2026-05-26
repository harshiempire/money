import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { throwForbidden } from "./forbidden";

export async function assertAccountOwned(
  userId: string,
  accountId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: schema.moneyAccounts.id })
    .from(schema.moneyAccounts)
    .where(
      and(
        eq(schema.moneyAccounts.id, accountId),
        eq(schema.moneyAccounts.userId, userId),
      ),
    )
    .limit(1);
  if (!row) throwForbidden();
}

export async function assertTransactionOwned(
  userId: string,
  transactionId: string,
): Promise<{ accountId: string }> {
  const [row] = await db
    .select({ accountId: schema.transactions.accountId })
    .from(schema.transactions)
    .innerJoin(
      schema.moneyAccounts,
      eq(schema.transactions.accountId, schema.moneyAccounts.id),
    )
    .where(
      and(
        eq(schema.transactions.id, transactionId),
        eq(schema.moneyAccounts.userId, userId),
      ),
    )
    .limit(1);
  if (!row) throwForbidden();
  return { accountId: row.accountId };
}

export async function assertCategoryOwned(
  userId: string,
  categoryId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(
      and(
        eq(schema.categories.id, categoryId),
        eq(schema.categories.userId, userId),
      ),
    )
    .limit(1);
  if (!row) throwForbidden();
}

export async function assertCounterpartyOwned(
  userId: string,
  counterpartyId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: schema.counterparties.id })
    .from(schema.counterparties)
    .where(
      and(
        eq(schema.counterparties.id, counterpartyId),
        eq(schema.counterparties.userId, userId),
      ),
    )
    .limit(1);
  if (!row) throwForbidden();
}

export async function assertPersonOwned(
  userId: string,
  personId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: schema.persons.id })
    .from(schema.persons)
    .where(
      and(eq(schema.persons.id, personId), eq(schema.persons.userId, userId)),
    )
    .limit(1);
  if (!row) throwForbidden();
}

export async function assertSplitParticipantOwned(
  userId: string,
  splitParticipantId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: schema.splitParticipants.id })
    .from(schema.splitParticipants)
    .innerJoin(
      schema.splits,
      eq(schema.splitParticipants.splitId, schema.splits.id),
    )
    .innerJoin(
      schema.transactions,
      eq(schema.splits.transactionId, schema.transactions.id),
    )
    .innerJoin(
      schema.moneyAccounts,
      eq(schema.transactions.accountId, schema.moneyAccounts.id),
    )
    .where(
      and(
        eq(schema.splitParticipants.id, splitParticipantId),
        eq(schema.moneyAccounts.userId, userId),
      ),
    )
    .limit(1);
  if (!row) throwForbidden();
}

export async function assertSettlementOwned(
  userId: string,
  settlementId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: schema.settlements.id })
    .from(schema.settlements)
    .leftJoin(
      schema.splitParticipants,
      eq(schema.settlements.splitParticipantId, schema.splitParticipants.id),
    )
    .leftJoin(
      schema.splits,
      eq(schema.splitParticipants.splitId, schema.splits.id),
    )
    .leftJoin(
      schema.transactions,
      eq(schema.splits.transactionId, schema.transactions.id),
    )
    .leftJoin(
      schema.moneyAccounts,
      eq(schema.transactions.accountId, schema.moneyAccounts.id),
    )
    .leftJoin(
      schema.owedExpenses,
      eq(schema.settlements.owedExpenseId, schema.owedExpenses.id),
    )
    .where(
      and(
        eq(schema.settlements.id, settlementId),
        sql`(
          ${schema.moneyAccounts.userId} = ${userId}
          OR ${schema.owedExpenses.userId} = ${userId}
        )`,
      ),
    )
    .limit(1);
  if (!row) throwForbidden();
}

export async function assertOwedExpenseOwned(
  userId: string,
  owedExpenseId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: schema.owedExpenses.id })
    .from(schema.owedExpenses)
    .where(
      and(
        eq(schema.owedExpenses.id, owedExpenseId),
        eq(schema.owedExpenses.userId, userId),
      ),
    )
    .limit(1);
  if (!row) throwForbidden();
}

export async function assertNetEventOwned(
  userId: string,
  netEventId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: schema.netEvents.id })
    .from(schema.netEvents)
    .where(
      and(
        eq(schema.netEvents.id, netEventId),
        eq(schema.netEvents.userId, userId),
      ),
    )
    .limit(1);
  if (!row) throwForbidden();
}

export async function assertTransactionsOwned(
  userId: string,
  transactionIds: string[],
): Promise<void> {
  if (transactionIds.length === 0) return;
  const rows = await db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .innerJoin(
      schema.moneyAccounts,
      eq(schema.transactions.accountId, schema.moneyAccounts.id),
    )
    .where(
      and(
        inArray(schema.transactions.id, transactionIds),
        eq(schema.moneyAccounts.userId, userId),
      ),
    );
  if (rows.length !== transactionIds.length) throwForbidden();
}
