import { Effect } from 'effect';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { Actor, Db } from '../services';
import { LedgerError } from '../context';
import { buildPersonBalances } from '../rules/balances';

export const loadBalances = Effect.fn('loadBalances')(function* () {
  const db = yield* Db, actor = yield* Actor;
  const { splitParticipants: p, splits: s, transactions: t, moneyAccounts: a, owedExpenses: o, settlements: st, counterparties: cp, persons } = schema;
  const owns = and(eq(a.id, actor.accountId), eq(a.userId, actor.userId));
  const [people, shares, owed, shareSettlements, owedSettlements, links] = yield* Effect.tryPromise({
    try: () => Promise.all([
      db.select({ id: persons.id, name: persons.name }).from(persons).where(eq(persons.userId, actor.userId)),
      db.select({ id: p.id, personId: p.personId, personName: p.personName, date: t.txnDate, what: t.rawDescription, amountPaise: p.expectedAmountPaise, txnId: t.id, order: s.createdAt,
        txnDescription: t.rawDescription, parsedPurpose: t.parsedPurpose, txnNote: t.note, counterpartyDisplayName: cp.displayName })
        .from(p).innerJoin(s, eq(p.splitId,s.id)).innerJoin(t,eq(s.transactionId,t.id)).innerJoin(a,and(eq(t.accountId,a.id),owns))
        .leftJoin(cp,and(eq(t.counterpartyId,cp.id),eq(cp.userId,actor.userId))),
      db.select({ id:o.id,personId:o.personId,personName:o.personName,date:o.incurredDate,what:o.description,amountPaise:o.amountPaise,categoryName:schema.categories.name })
        .from(o).leftJoin(schema.categories,and(eq(o.categoryId,schema.categories.id),eq(schema.categories.userId,actor.userId))).where(eq(o.userId,actor.userId)),
      db.select({ target:st.splitParticipantId,amountPaise:st.amountPaise }).from(st).innerJoin(p,eq(st.splitParticipantId,p.id)).innerJoin(s,eq(p.splitId,s.id)).innerJoin(t,eq(s.transactionId,t.id)).innerJoin(a,and(eq(t.accountId,a.id),owns)),
      db.select({ target:st.owedExpenseId,amountPaise:st.amountPaise }).from(st).innerJoin(o,eq(st.owedExpenseId,o.id)).where(eq(o.userId,actor.userId)),
      db.select({ personId:cp.personId,key:cp.key,displayName:cp.displayName,kind:cp.kind }).from(cp).innerJoin(a,owns)
        .innerJoin(persons,and(eq(cp.personId,persons.id),eq(persons.userId,actor.userId)))
        .where(and(eq(cp.userId,actor.userId),sql`exists (select 1 from ${t} where ${t.accountId} = ${a.id} and ${t.counterpartyId} = ${cp.id})`)),
    ]),
    catch: () => new LedgerError({ code:'unavailable',message:'Could not load balances.' }),
  });
  const shareRows = shares.map(r => ({ ...r, order:r.order.toISOString(), settledRows:shareSettlements.filter(st => st.target === r.id) }));
  const owedRows = owed.map(r => ({ ...r, settledRows:owedSettlements.filter(st => st.target === r.id) }));
  const balances = buildPersonBalances({ people, shares:shareRows, owed:owedRows });
  if (balances === null) return yield* new LedgerError({ code:'invalid_amount',message:'Balance exceeds the exact integer paise range.' });
  return balances.map(p => ({ ...p, linkedPayees:links.filter(l => l.personId === p.personId).sort((a,b) => a.key.localeCompare(b.key)),
    // Full typed metadata stays inside the server read; adapters choose their own presentation.
    shareRows:shareRows.filter(r => p.shares.some(s => s.id === r.id)), owedRows:owedRows.filter(r => p.owed.some(o => o.id === r.id)) }));
});
export const loadPersonBalance = Effect.fn('loadPersonBalance')(function* (keyOrId: string) {
  const balances = yield* loadBalances();
  return balances.find(p => p.key === keyOrId || p.personId === keyOrId) ?? null;
});
