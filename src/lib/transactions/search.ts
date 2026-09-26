import "server-only";
import { and, desc, eq, gte, lte, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import type { DateWindow } from "@/lib/dates/partial-date";
import { counterpartyLabel } from "@/lib/format";
import type { CandidateRow } from "@/lib/assistant/rank";

const t = schema.transactions;

/**
 * Literal, case-insensitive substring match across description, note,
 * purpose and the user's own counterparty names. %, _ and backslashes are
 * not wildcards. Shared by the transactions page and the assistant.
 */
export function transactionTextMatch(query: string, userId: string): SQL<boolean> {
  return sql<boolean>`(
    strpos(lower(${t.rawDescription}), lower(${query})) > 0
    or strpos(lower(coalesce(${t.note}, '')), lower(${query})) > 0
    or strpos(lower(coalesce(${t.parsedPurpose}, '')), lower(${query})) > 0
    or exists (select 1 from ${schema.counterparties}
      where ${schema.counterparties.id} = ${t.counterpartyId}
      and ${schema.counterparties.userId} = ${userId}
      and strpos(lower(${schema.counterparties.displayName}), lower(${query})) > 0)
  )`;
}

/** Calendar years this account has transactions in, oldest first. */
export async function yearsWithData(accountId: string): Promise<number[]> {
  const rows = await db
    .selectDistinct({ year: sql<number>`extract(year from ${t.txnDate})::int` })
    .from(t)
    .where(eq(t.accountId, accountId));
  return rows.map((r) => Number(r.year)).sort((a, b) => a - b);
}

/**
 * Candidates for the assistant. Every filter is ANDed onto the caller's
 * account, so results can never leave the signed-in tenant. Returns [] when
 * no criterion was given rather than dumping the whole account.
 */
export async function findTransactionCandidates(input: {
  accountId: string;
  userId: string;
  amountPaise: number | null;
  windows: DateWindow[];
  text: string | null;
  direction: "debit" | "credit" | "any";
  limit?: number;
}): Promise<CandidateRow[]> {
  const filters: SQL[] = [eq(t.accountId, input.accountId)];
  let criteria = 0;

  if (input.amountPaise !== null) {
    filters.push(eq(t.amountPaise, input.amountPaise));
    criteria++;
  }
  if (input.windows.length > 0) {
    filters.push(or(...input.windows.map((w) => and(gte(t.txnDate, w.from), lte(t.txnDate, w.to))))!);
    criteria++;
  }
  if (input.text) {
    filters.push(transactionTextMatch(input.text, input.userId));
    criteria++;
  }
  if (criteria === 0) return [];
  if (input.direction !== "any") filters.push(eq(t.drCr, input.direction));

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
      counterpartyDisplayName: schema.counterparties.displayName,
    })
    .from(t)
    .leftJoin(
      schema.counterparties,
      and(eq(t.counterpartyId, schema.counterparties.id), eq(schema.counterparties.userId, input.userId)),
    )
    .where(and(...filters))
    .orderBy(desc(t.txnDate), desc(t.createdAt))
    .limit(input.limit ?? 50);

  return rows.map((r) => ({
    id: r.id,
    txnDate: r.txnDate,
    amountPaise: Number(r.amountPaise),
    drCr: r.drCr,
    label: r.counterpartyDisplayName ?? counterpartyLabel(r.rawDescription),
    counterpartyDisplayName: r.counterpartyDisplayName,
    channel: r.channel,
    rawDescription: r.rawDescription,
    parsedPurpose: r.parsedPurpose,
    note: r.note,
  }));
}
