import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { counterpartyLabel } from "@/lib/format";
import type { ContextNote, TagFact, UntaggedMonth } from "./tag-batch";

export type { ContextNote, UntaggedMonth };

const t = schema.transactions;

export function monthBounds(year: number, month: number): { from: string; to: string } {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return { from, to: `${nextYear}-${String(nextMonth).padStart(2, "0")}-01` };
}

function toFact(row: {
  id: string;
  txnDate: string;
  amountPaise: number;
  drCr: "debit" | "credit";
  channel: string;
  categoryId: string | null;
  isTransfer: boolean;
  counterpartyId: string | null;
  displayName: string | null;
  parsedPurpose: string | null;
  rawDescription: string;
  note: string | null;
  bankRefId: string;
  defaultCategoryId: string | null;
}): TagFact {
  return {
    id: row.id,
    txnDate: row.txnDate,
    amountPaise: Number(row.amountPaise),
    drCr: row.drCr,
    channel: row.channel,
    categoryId: row.categoryId,
    isTransfer: row.isTransfer,
    counterpartyId: row.counterpartyId,
    displayName: row.displayName,
    parsedPurpose: row.parsedPurpose,
    label: counterpartyLabel(row.rawDescription),
    note: row.note,
    bankRefId: row.bankRefId,
    defaultCategoryId: row.defaultCategoryId,
  };
}

export async function loadTagFacts(accountId: string, userId: string, extra: SQL | undefined): Promise<TagFact[]> {
  const rows = await db
    .select({
      id: t.id,
      txnDate: t.txnDate,
      amountPaise: t.amountPaise,
      drCr: t.drCr,
      channel: t.channel,
      categoryId: t.categoryId,
      isTransfer: t.isTransfer,
      counterpartyId: t.counterpartyId,
      displayName: schema.counterparties.displayName,
      parsedPurpose: t.parsedPurpose,
      rawDescription: t.rawDescription,
      note: t.note,
      bankRefId: t.refId,
      defaultCategoryId: schema.counterparties.defaultCategoryId,
    })
    .from(t)
    .leftJoin(
      schema.counterparties,
      and(eq(t.counterpartyId, schema.counterparties.id), eq(schema.counterparties.userId, userId)),
    )
    .where(and(eq(t.accountId, accountId), extra));
  return rows.map(toFact);
}

export async function listUntaggedMonths(accountId: string): Promise<UntaggedMonth[]> {
  const rows = await db
    .select({ txnDate: t.txnDate })
    .from(t)
    .where(and(eq(t.accountId, accountId), isNull(t.categoryId)));
  const counts = new Map<string, UntaggedMonth>();
  for (const row of rows) {
    const year = Number(row.txnDate.slice(0, 4));
    const month = Number(row.txnDate.slice(5, 7));
    const key = `${year}-${month}`;
    const cur = counts.get(key);
    if (cur) cur.count += 1;
    else counts.set(key, { year, month, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.year - a.year || b.month - a.month);
}

export async function loadContextNotes(userId: string): Promise<ContextNote[]> {
  return db
    .select({ id: schema.assistantContextNotes.id, body: schema.assistantContextNotes.body })
    .from(schema.assistantContextNotes)
    .where(eq(schema.assistantContextNotes.userId, userId))
    .orderBy(asc(schema.assistantContextNotes.createdAt));
}
