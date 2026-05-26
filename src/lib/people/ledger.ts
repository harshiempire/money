import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  settledAmountByOwedExpenseIds,
  settledAmountByParticipantIds,
} from "@/lib/splits/outstanding";

export interface PersonBalanceRow {
  personId: string;
  personName: string;
  receivableOutstandingPaise: number;
  payableOutstandingPaise: number;
  netPaise: number;
  openReceivableCount: number;
  openPayableCount: number;
}

export interface PersonReceivableRow {
  participantId: string;
  txnDate: string;
  txnDescription: string;
  expectedPaise: number;
  settledPaise: number;
  outstandingPaise: number;
}

export interface PersonPayableRow {
  owedExpenseId: string;
  incurredDate: string;
  description: string;
  amountPaise: number;
  settledPaise: number;
  outstandingPaise: number;
  categoryName: string | null;
}

export interface PersonNetEventRow {
  netEventId: string;
  eventDate: string;
  note: string | null;
  receivablePaise: number;
  payablePaise: number;
  bankDeltaPaise: number;
}

async function loadAllReceivablesForUser(userId: string) {
  const accounts = await db
    .select({ id: schema.moneyAccounts.id })
    .from(schema.moneyAccounts)
    .where(eq(schema.moneyAccounts.userId, userId));
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return [];

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
    .where(inArray(schema.transactions.accountId, accountIds));

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

  return participants.map((p) => {
    const meta = splitMeta.get(p.splitId)!;
    const expected = Number(p.expectedAmountPaise);
    const paid = settled.get(p.id) ?? 0;
    return {
      personId: p.personId,
      personName: p.personName,
      participantId: p.id,
      txnDate: meta.txnDate,
      txnDescription: meta.rawDescription,
      expectedPaise: expected,
      settledPaise: paid,
      outstandingPaise: Math.max(0, expected - paid),
    };
  });
}

async function loadAllPayablesForUser(userId: string) {
  const expenses = await db
    .select({
      id: schema.owedExpenses.id,
      personId: schema.owedExpenses.personId,
      personName: schema.owedExpenses.personName,
      incurredDate: schema.owedExpenses.incurredDate,
      description: schema.owedExpenses.description,
      amountPaise: schema.owedExpenses.amountPaise,
      categoryName: schema.categories.name,
    })
    .from(schema.owedExpenses)
    .leftJoin(
      schema.categories,
      eq(schema.owedExpenses.categoryId, schema.categories.id),
    )
    .where(eq(schema.owedExpenses.userId, userId));

  if (expenses.length === 0) return [];

  const settled = await settledAmountByOwedExpenseIds(
    expenses.map((e) => e.id),
  );

  return expenses.map((e) => {
    const amount = Number(e.amountPaise);
    const paid = settled.get(e.id) ?? 0;
    return {
      personId: e.personId,
      personName: e.personName,
      owedExpenseId: e.id,
      incurredDate: e.incurredDate,
      description: e.description,
      amountPaise: amount,
      settledPaise: paid,
      outstandingPaise: Math.max(0, amount - paid),
      categoryName: e.categoryName,
    };
  });
}

export async function listPersonBalances(
  userId: string,
): Promise<PersonBalanceRow[]> {
  const [receivables, payables, persons] = await Promise.all([
    loadAllReceivablesForUser(userId),
    loadAllPayablesForUser(userId),
    db
      .select({ id: schema.persons.id, name: schema.persons.name })
      .from(schema.persons)
      .where(eq(schema.persons.userId, userId)),
  ]);

  const personIdByLowerName = new Map(
    persons.map((p) => [p.name.toLowerCase(), p.id]),
  );

  const resolvePersonId = (
    personId: string | null,
    personName: string,
  ): string | null =>
    personId ?? personIdByLowerName.get(personName.toLowerCase()) ?? null;

  const byPerson = new Map<
    string,
    {
      personId: string;
      personName: string;
      receivableOutstandingPaise: number;
      payableOutstandingPaise: number;
      openReceivableCount: number;
      openPayableCount: number;
    }
  >();

  const personKey = (personId: string | null, personName: string) => {
    const resolved = resolvePersonId(personId, personName);
    return resolved ? `id:${resolved}` : `name:${personName.toLowerCase()}`;
  };

  for (const r of receivables) {
    if (r.outstandingPaise <= 0) continue;
    const key = personKey(r.personId, r.personName);
    const resolvedId = resolvePersonId(r.personId, r.personName);
    const entry = byPerson.get(key) ?? {
      personId: resolvedId ?? key,
      personName: r.personName,
      receivableOutstandingPaise: 0,
      payableOutstandingPaise: 0,
      openReceivableCount: 0,
      openPayableCount: 0,
    };
    entry.receivableOutstandingPaise += r.outstandingPaise;
    entry.openReceivableCount += 1;
    byPerson.set(key, entry);
  }

  for (const p of payables) {
    if (p.outstandingPaise <= 0) continue;
    const key = personKey(p.personId, p.personName);
    const resolvedId = resolvePersonId(p.personId, p.personName);
    const entry = byPerson.get(key) ?? {
      personId: resolvedId ?? key,
      personName: p.personName,
      receivableOutstandingPaise: 0,
      payableOutstandingPaise: 0,
      openReceivableCount: 0,
      openPayableCount: 0,
    };
    entry.payableOutstandingPaise += p.outstandingPaise;
    entry.openPayableCount += 1;
    byPerson.set(key, entry);
  }

  return [...byPerson.values()]
    .map((p) => ({
      ...p,
      netPaise: p.receivableOutstandingPaise - p.payableOutstandingPaise,
    }))
    .filter(
      (p) =>
        p.receivableOutstandingPaise > 0 || p.payableOutstandingPaise > 0,
    )
    .sort((a, b) => Math.abs(b.netPaise) - Math.abs(a.netPaise));
}

export async function getPersonDetail(
  userId: string,
  personId: string,
): Promise<{
  personName: string;
  receivables: PersonReceivableRow[];
  payables: PersonPayableRow[];
  netEvents: PersonNetEventRow[];
  receivableOutstandingPaise: number;
  payableOutstandingPaise: number;
  netPaise: number;
} | null> {
  const [person] = await db
    .select()
    .from(schema.persons)
    .where(
      and(eq(schema.persons.id, personId), eq(schema.persons.userId, userId)),
    )
    .limit(1);

  if (!person) return null;

  const [allReceivables, allPayables] = await Promise.all([
    loadAllReceivablesForUser(userId),
    loadAllPayablesForUser(userId),
  ]);

  const receivables = allReceivables
    .filter(
      (r) =>
        r.personId === person.id ||
        r.personName.toLowerCase() === person.name.toLowerCase(),
    )
    .filter((r) => r.outstandingPaise > 0)
    .map((r) => ({
      participantId: r.participantId,
      txnDate: r.txnDate,
      txnDescription: r.txnDescription,
      expectedPaise: r.expectedPaise,
      settledPaise: r.settledPaise,
      outstandingPaise: r.outstandingPaise,
    }));

  const payables = allPayables
    .filter(
      (p) =>
        p.personId === person.id ||
        p.personName.toLowerCase() === person.name.toLowerCase(),
    )
    .filter((p) => p.outstandingPaise > 0)
    .map((p) => ({
      owedExpenseId: p.owedExpenseId,
      incurredDate: p.incurredDate,
      description: p.description,
      amountPaise: p.amountPaise,
      settledPaise: p.settledPaise,
      outstandingPaise: p.outstandingPaise,
      categoryName: p.categoryName,
    }));

  const netEventsRaw = await db
    .select()
    .from(schema.netEvents)
    .where(eq(schema.netEvents.userId, userId))
    .orderBy(schema.netEvents.eventDate);

  const netEventIds = netEventsRaw.map((e) => e.id);
  const settlements =
    netEventIds.length > 0
      ? await db
          .select()
          .from(schema.settlements)
          .where(inArray(schema.settlements.netEventId, netEventIds))
      : [];

  const participantIds = settlements
    .map((s) => s.splitParticipantId)
    .filter((id): id is string => id != null);
  const owedExpenseIds = settlements
    .map((s) => s.owedExpenseId)
    .filter((id): id is string => id != null);

  const participantRows =
    participantIds.length > 0
      ? await db
          .select()
          .from(schema.splitParticipants)
          .where(inArray(schema.splitParticipants.id, participantIds))
      : [];
  const owedRows =
    owedExpenseIds.length > 0
      ? await db
          .select()
          .from(schema.owedExpenses)
          .where(inArray(schema.owedExpenses.id, owedExpenseIds))
      : [];

  const personParticipantIds = new Set(
    participantRows
      .filter(
        (p) =>
          p.personId === person.id ||
          p.personName.toLowerCase() === person.name.toLowerCase(),
      )
      .map((p) => p.id),
  );
  const personOwedIds = new Set(
    owedRows
      .filter(
        (o) =>
          o.personId === person.id ||
          o.personName.toLowerCase() === person.name.toLowerCase(),
      )
      .map((o) => o.id),
  );

  const netEvents: PersonNetEventRow[] = [];
  for (const event of netEventsRaw) {
    const eventSettlements = settlements.filter(
      (s) => s.netEventId === event.id,
    );
    const involvesPerson = eventSettlements.some(
      (s) =>
        (s.splitParticipantId &&
          personParticipantIds.has(s.splitParticipantId)) ||
        (s.owedExpenseId && personOwedIds.has(s.owedExpenseId)),
    );
    if (!involvesPerson) continue;

    let receivablePaise = 0;
    let payablePaise = 0;
    for (const s of eventSettlements) {
      if (
        s.splitParticipantId &&
        personParticipantIds.has(s.splitParticipantId)
      ) {
        receivablePaise += Number(s.amountPaise);
      }
      if (s.owedExpenseId && personOwedIds.has(s.owedExpenseId)) {
        payablePaise += Number(s.amountPaise);
      }
    }

    let bankDeltaPaise = 0;
    if (event.inflowTransactionId) {
      const [inflow] = await db
        .select({ amountPaise: schema.transactions.amountPaise })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, event.inflowTransactionId))
        .limit(1);
      bankDeltaPaise += inflow ? Number(inflow.amountPaise) : 0;
    }
    if (event.outflowTransactionId) {
      const [outflow] = await db
        .select({ amountPaise: schema.transactions.amountPaise })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, event.outflowTransactionId))
        .limit(1);
      bankDeltaPaise -= outflow ? Number(outflow.amountPaise) : 0;
    }

    netEvents.push({
      netEventId: event.id,
      eventDate: event.eventDate,
      note: event.note,
      receivablePaise,
      payablePaise,
      bankDeltaPaise,
    });
  }

  const receivableOutstandingPaise = receivables.reduce(
    (s, r) => s + r.outstandingPaise,
    0,
  );
  const payableOutstandingPaise = payables.reduce(
    (s, p) => s + p.outstandingPaise,
    0,
  );

  return {
    personName: person.name,
    receivables,
    payables,
    netEvents: netEvents.sort((a, b) =>
      b.eventDate.localeCompare(a.eventDate),
    ),
    receivableOutstandingPaise,
    payableOutstandingPaise,
    netPaise: receivableOutstandingPaise - payableOutstandingPaise,
  };
}
