import "server-only";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  settledAmountByOwedExpenseIds,
  settledAmountByParticipantIds,
} from "@/lib/splits/outstanding";

export interface ReceivableOption {
  id: string;
  personName: string;
  personId: string | null;
  expectedAmountPaise: number;
  outstandingPaise: number;
  splitTransactionDate: string;
  splitTransactionDescription: string;
}

export interface PayableOption {
  id: string;
  personName: string;
  personId: string | null;
  amountPaise: number;
  outstandingPaise: number;
  incurredDate: string;
  description: string;
  categoryId: string | null;
}

export async function loadOpenReceivablesForAccount(
  accountId: string,
): Promise<ReceivableOption[]> {
  const splitsRaw = await db
    .select({
      splitId: schema.splits.id,
      txnDate: schema.transactions.txnDate,
      rawDescription: schema.transactions.rawDescription,
    })
    .from(schema.splits)
    .innerJoin(
      schema.transactions,
      eq(schema.splits.transactionId, schema.transactions.id),
    )
    .where(eq(schema.transactions.accountId, accountId));

  if (splitsRaw.length === 0) return [];

  const participants = await db
    .select()
    .from(schema.splitParticipants)
    .where(
      inArray(
        schema.splitParticipants.splitId,
        splitsRaw.map((s) => s.splitId),
      ),
    );

  const settled = await settledAmountByParticipantIds(
    participants.map((p) => p.id),
  );
  const splitMeta = new Map(splitsRaw.map((s) => [s.splitId, s]));

  return participants
    .map((p) => {
      const meta = splitMeta.get(p.splitId)!;
      const expected = Number(p.expectedAmountPaise);
      const paid = settled.get(p.id) ?? 0;
      const outstandingPaise = Math.max(0, expected - paid);
      return {
        id: p.id,
        personName: p.personName,
        personId: p.personId,
        expectedAmountPaise: expected,
        outstandingPaise,
        splitTransactionDate: meta.txnDate,
        splitTransactionDescription: meta.rawDescription,
      };
    })
    .filter((r) => r.outstandingPaise > 0);
}

export async function loadOpenPayablesForUser(
  userId: string,
): Promise<PayableOption[]> {
  const expenses = await db
    .select()
    .from(schema.owedExpenses)
    .where(eq(schema.owedExpenses.userId, userId));

  if (expenses.length === 0) return [];

  const settled = await settledAmountByOwedExpenseIds(
    expenses.map((e) => e.id),
  );

  return expenses
    .map((e) => {
      const amountPaise = Number(e.amountPaise);
      const paid = settled.get(e.id) ?? 0;
      const outstandingPaise = Math.max(0, amountPaise - paid);
      return {
        id: e.id,
        personName: e.personName,
        personId: e.personId,
        amountPaise,
        outstandingPaise,
        incurredDate: e.incurredDate,
        description: e.description,
        categoryId: e.categoryId,
      };
    })
    .filter((p) => p.outstandingPaise > 0);
}

export interface NetEventByTransaction {
  netEventId: string;
  eventDate: string;
  note: string | null;
  legs: Array<{
    kind: "receivable" | "payable";
    targetId: string;
    amountPaise: number;
    method: "bank" | "cash" | "offset";
  }>;
}

export async function loadNetEventsByTransactionIds(
  transactionIds: string[],
): Promise<Map<string, NetEventByTransaction>> {
  const result = new Map<string, NetEventByTransaction>();
  if (transactionIds.length === 0) return result;

  const events = await db
    .select()
    .from(schema.netEvents)
    .where(
      inArray(schema.netEvents.inflowTransactionId, transactionIds),
    );

  const outflowEvents = await db
    .select()
    .from(schema.netEvents)
    .where(
      inArray(schema.netEvents.outflowTransactionId, transactionIds),
    );

  const allEvents = [...events, ...outflowEvents];
  const uniqueEvents = [...new Map(allEvents.map((e) => [e.id, e])).values()];
  if (uniqueEvents.length === 0) return result;

  const settlements = await db
    .select()
    .from(schema.settlements)
    .where(
      inArray(
        schema.settlements.netEventId,
        uniqueEvents.map((e) => e.id),
      ),
    );

  for (const event of uniqueEvents) {
    const eventSettlements = settlements.filter(
      (s) => s.netEventId === event.id,
    );
    const legs = eventSettlements.map((s) => {
      if (s.splitParticipantId) {
        return {
          kind: "receivable" as const,
          targetId: s.splitParticipantId,
          amountPaise: Number(s.amountPaise),
          method: s.method,
        };
      }
      return {
        kind: "payable" as const,
        targetId: s.owedExpenseId!,
        amountPaise: Number(s.amountPaise),
        method: s.method,
      };
    });

    const payload: NetEventByTransaction = {
      netEventId: event.id,
      eventDate: event.eventDate,
      note: event.note,
      legs,
    };

    if (event.inflowTransactionId) {
      result.set(event.inflowTransactionId, payload);
    }
    if (event.outflowTransactionId) {
      result.set(event.outflowTransactionId, payload);
    }
  }

  return result;
}
