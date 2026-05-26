import "server-only";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";

export async function settledAmountByParticipantIds(
  participantIds: string[],
  excludeNetEventId?: string,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (participantIds.length === 0) return result;

  const rows = await db
    .select({
      splitParticipantId: schema.settlements.splitParticipantId,
      amountPaise: schema.settlements.amountPaise,
      netEventId: schema.settlements.netEventId,
    })
    .from(schema.settlements)
    .where(inArray(schema.settlements.splitParticipantId, participantIds));

  for (const row of rows) {
    if (!row.splitParticipantId) continue;
    if (excludeNetEventId && row.netEventId === excludeNetEventId) continue;
    result.set(
      row.splitParticipantId,
      (result.get(row.splitParticipantId) ?? 0) + Number(row.amountPaise),
    );
  }
  return result;
}

export async function settledAmountByOwedExpenseIds(
  owedExpenseIds: string[],
  excludeNetEventId?: string,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (owedExpenseIds.length === 0) return result;

  const rows = await db
    .select({
      owedExpenseId: schema.settlements.owedExpenseId,
      amountPaise: schema.settlements.amountPaise,
      netEventId: schema.settlements.netEventId,
    })
    .from(schema.settlements)
    .where(inArray(schema.settlements.owedExpenseId, owedExpenseIds));

  for (const row of rows) {
    if (!row.owedExpenseId) continue;
    if (excludeNetEventId && row.netEventId === excludeNetEventId) continue;
    result.set(
      row.owedExpenseId,
      (result.get(row.owedExpenseId) ?? 0) + Number(row.amountPaise),
    );
  }
  return result;
}

export async function participantOutstanding(
  participantId: string,
  excludeNetEventId?: string,
): Promise<number> {
  const [participant] = await db
    .select({
      expectedAmountPaise: schema.splitParticipants.expectedAmountPaise,
    })
    .from(schema.splitParticipants)
    .where(eq(schema.splitParticipants.id, participantId))
    .limit(1);
  if (!participant) return 0;

  const settled = await settledAmountByParticipantIds(
    [participantId],
    excludeNetEventId,
  );
  const expected = Number(participant.expectedAmountPaise);
  const paid = settled.get(participantId) ?? 0;
  return Math.max(0, expected - paid);
}

export async function owedExpenseOutstanding(
  owedExpenseId: string,
  excludeNetEventId?: string,
): Promise<number> {
  const [expense] = await db
    .select({ amountPaise: schema.owedExpenses.amountPaise })
    .from(schema.owedExpenses)
    .where(eq(schema.owedExpenses.id, owedExpenseId))
    .limit(1);
  if (!expense) return 0;

  const settled = await settledAmountByOwedExpenseIds(
    [owedExpenseId],
    excludeNetEventId,
  );
  const expected = Number(expense.amountPaise);
  const paid = settled.get(owedExpenseId) ?? 0;
  return Math.max(0, expected - paid);
}
