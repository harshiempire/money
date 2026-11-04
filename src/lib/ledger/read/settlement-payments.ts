import 'server-only';
import { Effect } from 'effect';
import { and, desc, eq, sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { Actor, Db } from '../services';
import { runLedger } from '../run';
import { LedgerError } from '../context';
import { inflowExplanation } from '../rules/settlement-policy';
import type { SettlementPayment } from '../rules/net-settlement-plan';

/** Candidate bank rows, scoped independently at every tenant-bearing join. */
export const loadSettlementPayments = Effect.fn('loadSettlementPayments')(function* () {
  const db = yield* Db, actor = yield* Actor;
  const { transactions: t, moneyAccounts: a, counterparties: c, persons: p, settlements: s, netEvents: n, owedExpenses: o, splits: b } = schema;
  const rows = yield* Effect.tryPromise({
    try: () => db.select({ id: t.id, date: t.txnDate, description: t.rawDescription, personName: p.name, direction: t.drCr, amountPaise: t.amountPaise,
      residualDisposition: t.residualDisposition, residualAcknowledgedPaise: t.residualAcknowledgedPaise,
      allocated: sql<number>`(select coalesce(sum(${s.amountPaise}),0) from ${s} where ${s.inflowTransactionId} = ${t.id})`,
      hasNetEvent: sql<boolean>`exists(select 1 from ${n} where ${n.userId} = ${actor.userId} and (${n.inflowTransactionId} = ${t.id} or ${n.outflowTransactionId} = ${t.id}))`,
      owedSourced: sql<boolean>`exists(select 1 from ${o} where ${o.userId} = ${actor.userId} and ${o.sourceInflowTransactionId} = ${t.id})`,
      split: sql<boolean>`exists(select 1 from ${b} where ${b.transactionId} = ${t.id})`,
    }).from(t).innerJoin(a, and(eq(t.accountId, a.id), eq(a.id, actor.accountId), eq(a.userId, actor.userId)))
      .leftJoin(c, and(eq(t.counterpartyId, c.id), eq(c.userId, actor.userId)))
      .leftJoin(p, and(eq(c.personId, p.id), eq(p.userId, actor.userId)))
      .orderBy(desc(t.txnDate), t.id),
    catch: () => new LedgerError({ code: 'unavailable', message: 'Could not load settlement payments.' }),
  });
  return rows.flatMap((r): SettlementPayment[] => {
    const e = inflowExplanation({ inflowAmountPaise: r.amountPaise, allocations: [{ amountPaise: Number(r.allocated) }], netReservedPaise: 0, hasNetEvent: r.hasNetEvent,
      owedSourced: r.owedSourced, residualDisposition: r.residualDisposition, residualAcknowledgedPaise: r.residualAcknowledgedPaise });
    return r.split || e.hasNetEvent || e.allocatedPaise || e.owedSourced || e.acknowledged ? [] : [{ id: r.id, date: r.date, description: r.description, personName: r.personName, direction: r.direction, amountPaise: r.amountPaise }];
  }).slice(0, 300);
});
export function loadSettlementPaymentsForAccount(actor: Actor['Service']) {
  return runLedger(loadSettlementPayments(), actor);
}
