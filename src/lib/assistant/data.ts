import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { counterpartyLabel } from "@/lib/format";
import { transactionHref } from "@/lib/transactions/href";
import { settledAmountByParticipantIds } from "@/lib/splits/outstanding";
import {
  loadNetEventsByTransactionIds,
  loadOpenPayablesForUser,
  loadOpenReceivablesForAccount,
} from "@/lib/net-events/load-net-settle-data";
import type { CategoryLite, NetLine, TxnCardData } from "./types";

const t = schema.transactions;

/**
 * Card data for transactions in this account. Ids outside the account are
 * silently dropped — the caller can't learn anything about other tenants.
 */
export async function loadTxnCards(accountId: string, userId: string, ids: string[]): Promise<TxnCardData[]> {
  const unique = [...new Set(ids)].slice(0, 50);
  if (unique.length === 0) return [];

  const rows = await db
    .select({
      id: t.id,
      txnDate: t.txnDate,
      amountPaise: t.amountPaise,
      drCr: t.drCr,
      channel: t.channel,
      rawDescription: t.rawDescription,
      parsedPurpose: t.parsedPurpose,
      note: t.note,
      categoryId: t.categoryId,
      needsReview: t.needsReview,
      counterpartyDisplayName: schema.counterparties.displayName,
    })
    .from(t)
    .leftJoin(
      schema.counterparties,
      and(eq(t.counterpartyId, schema.counterparties.id), eq(schema.counterparties.userId, userId)),
    )
    .where(and(eq(t.accountId, accountId), inArray(t.id, unique)));
  if (rows.length === 0) return [];

  const rowIds = rows.map((r) => r.id);
  const [splits, netEvents] = await Promise.all([
    db.select().from(schema.splits).where(inArray(schema.splits.transactionId, rowIds)),
    loadNetEventsByTransactionIds(rowIds),
  ]);
  const participants = splits.length
    ? await db
        .select()
        .from(schema.splitParticipants)
        .where(inArray(schema.splitParticipants.splitId, splits.map((s) => s.id)))
    : [];
  const settled = await settledAmountByParticipantIds(participants.map((p) => p.id));

  const splitByTxn = new Map<string, TxnCardData["split"]>();
  for (const s of splits) {
    const ps = participants.filter((p) => p.splitId === s.id);
    let settledCount = 0;
    let pendingPaise = 0;
    for (const p of ps) {
      const outstanding = Math.max(0, Number(p.expectedAmountPaise) - (settled.get(p.id) ?? 0));
      if (outstanding === 0) settledCount++;
      pendingPaise += outstanding;
    }
    splitByTxn.set(s.transactionId, {
      participants: ps.length,
      settled: settledCount,
      pendingPaise,
      yourSharePaise: Number(s.yourSharePaise),
    });
  }

  const order = new Map(unique.map((id, i) => [id, i]));
  return rows
    .map((r) => ({
      id: r.id,
      txnDate: r.txnDate,
      amountPaise: Number(r.amountPaise),
      drCr: r.drCr,
      channel: r.channel,
      label: r.counterpartyDisplayName ?? counterpartyLabel(r.rawDescription),
      purpose: r.parsedPurpose,
      note: r.note,
      categoryId: r.categoryId,
      needsReview: r.needsReview,
      split: splitByTxn.get(r.id) ?? null,
      netEventId: netEvents.get(r.id)?.netEventId ?? null,
      href: transactionHref(r.id),
    }))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export async function loadCategories(userId: string): Promise<CategoryLite[]> {
  return db
    .select({ id: schema.categories.id, name: schema.categories.name, kind: schema.categories.kind })
    .from(schema.categories)
    .where(eq(schema.categories.userId, userId))
    .orderBy(asc(schema.categories.kind), asc(schema.categories.name));
}

export async function loadPersonNames(userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: schema.persons.name })
    .from(schema.persons)
    .where(eq(schema.persons.userId, userId))
    .orderBy(asc(schema.persons.name));
  return rows.map((r) => r.name);
}

/** Open receivables (they owe you) and payables (you owe them) with one person. */
export async function loadOpenLinesForPerson(
  accountId: string,
  userId: string,
  person: string,
): Promise<{ recv: NetLine[]; pay: NetLine[] }> {
  const [receivables, payables] = await Promise.all([
    loadOpenReceivablesForAccount(accountId),
    loadOpenPayablesForUser(userId),
  ]);
  const same = (name: string) => name.trim().toLowerCase() === person.trim().toLowerCase();
  return {
    recv: receivables
      .filter((r) => same(r.personName))
      .map((r) => ({
        id: r.id,
        person: r.personName,
        date: r.splitTransactionDate,
        desc: counterpartyLabel(r.splitTransactionDescription),
        outstandingPaise: r.outstandingPaise,
        val: "",
      })),
    pay: payables
      .filter((p) => same(p.personName))
      .map((p) => ({
        id: p.id,
        person: p.personName,
        date: p.incurredDate,
        desc: p.description,
        outstandingPaise: p.outstandingPaise,
        val: "",
      })),
  };
}
