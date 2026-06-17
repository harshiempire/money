import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";

function mergeHintRows(
  bestByCounterparty: Map<string, { name: string; count: number }>,
  rows: Array<{
    counterpartyId: string | null;
    personName: string;
    count: number;
  }>,
) {
  for (const row of rows) {
    if (!row.counterpartyId) continue;
    const prev = bestByCounterparty.get(row.counterpartyId);
    if (!prev || row.count > prev.count) {
      bestByCounterparty.set(row.counterpartyId, {
        name: row.personName,
        count: row.count,
      });
    }
  }
}

export async function loadCounterpartyPersonHints(
  accountIds: string[],
): Promise<Record<string, string>> {
  if (accountIds.length === 0) return {};

  const baseWhere = and(
    inArray(schema.transactions.accountId, accountIds),
    isNotNull(schema.transactions.counterpartyId),
  );

  const [bankSettleRows, netEventRows] = await Promise.all([
    db
      .select({
        counterpartyId: schema.transactions.counterpartyId,
        personName: schema.splitParticipants.personName,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.settlements)
      .innerJoin(
        schema.transactions,
        eq(schema.settlements.inflowTransactionId, schema.transactions.id),
      )
      .innerJoin(
        schema.splitParticipants,
        eq(schema.settlements.splitParticipantId, schema.splitParticipants.id),
      )
      .where(and(baseWhere, eq(schema.settlements.method, "bank")))
      .groupBy(
        schema.transactions.counterpartyId,
        schema.splitParticipants.personName,
      ),
    db
      .select({
        counterpartyId: schema.transactions.counterpartyId,
        personName: schema.splitParticipants.personName,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.settlements)
      .innerJoin(
        schema.netEvents,
        eq(schema.settlements.netEventId, schema.netEvents.id),
      )
      .innerJoin(
        schema.transactions,
        eq(schema.netEvents.inflowTransactionId, schema.transactions.id),
      )
      .innerJoin(
        schema.splitParticipants,
        eq(schema.settlements.splitParticipantId, schema.splitParticipants.id),
      )
      .where(baseWhere)
      .groupBy(
        schema.transactions.counterpartyId,
        schema.splitParticipants.personName,
      ),
  ]);

  const bestByCounterparty = new Map<string, { name: string; count: number }>();
  mergeHintRows(bestByCounterparty, bankSettleRows);
  mergeHintRows(bestByCounterparty, netEventRows);

  return Object.fromEntries(
    [...bestByCounterparty.entries()].map(([id, { name }]) => [id, name]),
  );
}
