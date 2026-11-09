import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { loadBalances } from '@/lib/ledger/read/balances';
import { runLedger } from '@/lib/ledger/run';
import { personBalanceKey } from '@/lib/ledger/rules/balances';

export interface PersonBalanceRow {
  personId: string;
  personName: string;
  receivableOutstandingPaise: number;
  payableOutstandingPaise: number;
  netPaise: number;
  openReceivableCount: number;
  openPayableCount: number;
  linkedPayees: string[];
}

export interface PersonReceivableRow {
  participantId: string;
  txnId: string;
  txnDate: string;
  txnDescription: string;
  counterpartyDisplayName: string | null;
  parsedPurpose: string | null;
  txnNote: string | null;
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

async function balancesForUser(userId: string) {
  const [account] = await db.select({ id: schema.moneyAccounts.id }).from(schema.moneyAccounts).where(and(eq(schema.moneyAccounts.userId, userId),eq(schema.moneyAccounts.bank,"bob"))).limit(1);
  return runLedger(loadBalances(), { userId, accountId: account?.id ?? "00000000-0000-0000-0000-000000000000" });
}
/** Confirmed payee links only, by display name when there is one. Several handles can share a name. */
const linkedPayeeLabels = (rows: ReadonlyArray<{ key: string; displayName: string | null }>) =>
  [...new Set(rows.map(row => row.displayName?.trim() || row.key))];

export async function listPersonBalances(userId: string): Promise<PersonBalanceRow[]> {
  return (await balancesForUser(userId)).filter(p => p.openShareCount || p.openOwedCount).map(p => ({
    personId:p.personId ?? p.key, personName:p.name, receivableOutstandingPaise:p.owedToYouPaise,
    payableOutstandingPaise:p.youOwePaise, netPaise:p.netPaise, openReceivableCount:p.openShareCount, openPayableCount:p.openOwedCount,
    linkedPayees:linkedPayeeLabels(p.linkedPayees),
  })).sort((a,b) => Math.abs(b.netPaise)-Math.abs(a.netPaise));
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
  linkedPayees: string[];
} | null> {
  const [person] = await db
    .select()
    .from(schema.persons)
    .where(
      and(eq(schema.persons.id, personId), eq(schema.persons.userId, userId)),
    )
    .limit(1);

  if (!person) return null;

  const balance = (await balancesForUser(userId)).find(p => p.personId === personId);
  const receivables: PersonReceivableRow[] = (balance?.shares ?? []).map(r => {
    const meta = balance!.shareRows.find(s => s.id === r.id)!;
    return { participantId:r.id,txnId:r.txnId!,txnDate:r.date,txnDescription:meta.txnDescription,
      counterpartyDisplayName:meta.counterpartyDisplayName,parsedPurpose:meta.parsedPurpose,txnNote:meta.txnNote,
      expectedPaise:r.amountPaise,settledPaise:r.settledPaise,outstandingPaise:r.leftPaise };
  });
  const payables: PersonPayableRow[] = (balance?.owed ?? []).map(r => ({ owedExpenseId:r.id,incurredDate:r.date,
    description:r.what,amountPaise:r.amountPaise,settledPaise:r.settledPaise,outstandingPaise:r.leftPaise,
    categoryName:balance!.owedRows.find(o => o.id === r.id)!.categoryName }));

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
          personBalanceKey(p.personId, p.personName) === personBalanceKey(person.id, person.name),
      )
      .map((p) => p.id),
  );
  const personOwedIds = new Set(
    owedRows
      .filter(
        (o) =>
          personBalanceKey(o.personId, o.personName) === personBalanceKey(person.id, person.name),
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
    linkedPayees: linkedPayeeLabels(balance?.linkedPayees ?? []),
  };
}
