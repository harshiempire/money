import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema } from "@/db";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
import type { McpReadModel } from "./read-model";
import type { McpTransaction } from "./view";

/** No client SQL reaches Postgres. All tables are scoped before the pure read model sees them. */
export async function loadMcpReadModel(actor: MoneyActor, loadTransactions: () => Promise<McpTransaction[]>): Promise<McpReadModel> {
  const a = schema.moneyAccounts, t = schema.transactions, p = schema.splitParticipants;
  const s = schema.splits, o = schema.owedExpenses, st = schema.settlements, cp = schema.counterparties;
  const owns = and(eq(a.id, actor.accountId), eq(a.userId, actor.userId));
  const category = alias(schema.categories, "mcp_default_category");
  const settlementFields = {
    id: st.id, splitParticipantId: st.splitParticipantId, owedExpenseId: st.owedExpenseId,
    inflowTransactionId: st.inflowTransactionId, netEventId: st.netEventId,
    amountPaise: st.amountPaise, method: st.method,
    createdDate: sql<string>`to_char(${st.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
  };
  const [transactions, people, payees, splits, shares, owed, shareSettlements, owedSettlements, netEvents, linkedInflows] = await Promise.all([
    loadTransactions(),
    db.select({ name: schema.persons.name }).from(schema.persons).where(eq(schema.persons.userId, actor.userId)).orderBy(schema.persons.name),
    db.select({ person: schema.persons.name, key: cp.key, kind: cp.kind, displayName: cp.displayName, defaultCategory: category.name, isSelf: cp.isSelf, isFamily: cp.isFamily })
      .from(cp).innerJoin(a, owns)
      .leftJoin(schema.persons, and(eq(cp.personId, schema.persons.id), eq(schema.persons.userId, actor.userId)))
      .leftJoin(category, and(eq(cp.defaultCategoryId, category.id), eq(category.userId, actor.userId)))
      .where(and(eq(cp.userId, actor.userId), sql`exists (select 1 from ${t} where ${t.accountId} = ${a.id} and ${t.counterpartyId} = ${cp.id})`)),
    db.select({ id: s.id, transactionId: s.transactionId, totalPaise: s.totalPaise, yourSharePaise: s.yourSharePaise })
      .from(s).innerJoin(t, eq(s.transactionId, t.id)).innerJoin(a, and(eq(t.accountId, a.id), owns)),
    db.select({ id: p.id, splitId: p.splitId, personName: p.personName, expectedAmountPaise: p.expectedAmountPaise })
      .from(p).innerJoin(s, eq(p.splitId, s.id)).innerJoin(t, eq(s.transactionId, t.id)).innerJoin(a, and(eq(t.accountId, a.id), owns)),
    db.select({ id: o.id, personName: o.personName, incurredDate: o.incurredDate, description: o.description, amountPaise: o.amountPaise, sourceInflowTransactionId: o.sourceInflowTransactionId })
      .from(o).where(eq(o.userId, actor.userId)),
    // Target ownership is the settlement's tenant seam. Do not join only via its nullable inflow.
    db.select(settlementFields).from(st).innerJoin(p, eq(st.splitParticipantId, p.id))
      .innerJoin(s, eq(p.splitId, s.id)).innerJoin(t, eq(s.transactionId, t.id)).innerJoin(a, and(eq(t.accountId, a.id), owns)),
    db.select(settlementFields).from(st).innerJoin(o, eq(st.owedExpenseId, o.id)).where(eq(o.userId, actor.userId)),
    db.select({ id: schema.netEvents.id, eventDate: schema.netEvents.eventDate, inflowTransactionId: schema.netEvents.inflowTransactionId, outflowTransactionId: schema.netEvents.outflowTransactionId })
      .from(schema.netEvents).where(eq(schema.netEvents.userId, actor.userId)),
    db.select({ id: t.id }).from(t).innerJoin(a, and(eq(t.accountId, a.id), owns))
      .where(and(eq(t.drCr, "credit"), sql`(
        exists (select 1 from ${st} where ${st.inflowTransactionId} = ${t.id})
        or exists (select 1 from ${schema.netEvents} where ${schema.netEvents.userId} = ${actor.userId}
          and (${schema.netEvents.inflowTransactionId} = ${t.id} or ${schema.netEvents.outflowTransactionId} = ${t.id}))
        or exists (select 1 from ${o} where ${o.userId} = ${actor.userId} and ${o.sourceInflowTransactionId} = ${t.id})
      )`)),
  ]);
  return { transactions, linkedInflows: linkedInflows.map((t) => t.id), people, payees, splits, shares, owed, settlements: [...shareSettlements, ...owedSettlements], netEvents };
}
