import "server-only";
import { type SQL, and, eq, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db";

/**
 * The single source of truth for "net personal spend" semantics:
 *
 *   net_self =
 *     + (debit amount, or your_share if a split exists)         when !is_transfer
 *     - (credit amount)                                          when !is_transfer && !is_settlement
 *     + 0                                                        otherwise
 *
 * "Settlement credits" are credits already accounted for via the related
 * debit's your_share, so counting them again would double-count.
 */
const netSelfExpr = sql<number>`
  case
    when ${schema.transactions.isTransfer} = true then 0
    when ${schema.transactions.drCr} = 'debit'
      then coalesce(
        (select ${schema.splits.yourSharePaise} from ${schema.splits}
         where ${schema.splits.transactionId} = ${schema.transactions.id}),
        ${schema.transactions.amountPaise}
      )
    when ${schema.transactions.drCr} = 'credit'
      and exists (
        select 1 from ${schema.settlements}
        where ${schema.settlements.inflowTransactionId} = ${schema.transactions.id}
      )
      then 0
    when ${schema.transactions.drCr} = 'credit'
      then -1 * ${schema.transactions.amountPaise}
    else 0
  end
`;

export interface NetSpendTotals {
  totalDebitPaise: number;
  totalCreditPaise: number;
  netSelfPaise: number;
  count: number;
}

const buildWhere = (
  accountId: string,
  from: string | null,
  to: string | null,
): SQL | undefined => {
  const filters = [eq(schema.transactions.accountId, accountId)];
  if (from) filters.push(gte(schema.transactions.txnDate, from));
  if (to) filters.push(lte(schema.transactions.txnDate, to));
  return and(...filters);
};

export async function netSpendTotals(
  accountId: string,
  from: string | null,
  to: string | null,
): Promise<NetSpendTotals> {
  const where = buildWhere(accountId, from, to);
  const [r] = await db
    .select({
      debit: sql<number>`coalesce(sum(case when ${schema.transactions.drCr} = 'debit' then ${schema.transactions.amountPaise} else 0 end), 0)::bigint`,
      credit: sql<number>`coalesce(sum(case when ${schema.transactions.drCr} = 'credit' then ${schema.transactions.amountPaise} else 0 end), 0)::bigint`,
      netSelf: sql<number>`coalesce(sum(${netSelfExpr}), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.transactions)
    .where(where);
  return {
    totalDebitPaise: Number(r.debit),
    totalCreditPaise: Number(r.credit),
    netSelfPaise: Number(r.netSelf),
    count: r.count,
  };
}

export interface CategoryRow {
  categoryId: string | null;
  categoryName: string;
  netSelfPaise: number;
  count: number;
}

/**
 * Net-self grouped by category over the period. Uncategorized rows surface
 * as "Uncategorized" so the user knows there's still work to triage.
 */
export async function categoryBreakdown(
  accountId: string,
  from: string | null,
  to: string | null,
): Promise<CategoryRow[]> {
  const where = buildWhere(accountId, from, to);
  const rows = await db
    .select({
      categoryId: schema.transactions.categoryId,
      categoryName: schema.categories.name,
      netSelf: sql<number>`coalesce(sum(${netSelfExpr}), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.categories,
      eq(schema.transactions.categoryId, schema.categories.id),
    )
    .where(where)
    .groupBy(schema.transactions.categoryId, schema.categories.name);

  return rows
    .map((r) => ({
      categoryId: r.categoryId,
      categoryName: r.categoryName ?? "Uncategorized",
      netSelfPaise: Number(r.netSelf),
      count: r.count,
    }))
    .filter((r) => r.netSelfPaise !== 0)
    .sort((a, b) => b.netSelfPaise - a.netSelfPaise);
}

export interface DailyBalance {
  date: string;
  balancePaise: number;
}

/**
 * Last known running balance per day in the period. We use the bank's
 * stored balance on the latest transaction of each date — no derivation,
 * so it stays trustworthy even if a row is missing.
 */
export async function dailyClosingBalance(
  accountId: string,
  from: string | null,
  to: string | null,
): Promise<DailyBalance[]> {
  const where = buildWhere(accountId, from, to);
  const rows = await db
    .select({
      date: schema.transactions.txnDate,
      balancePaise: sql<number>`(
        array_agg(${schema.transactions.balancePaise} order by ${schema.transactions.createdAt} desc, (${schema.transactions.rawPayload}->>'serial')::int desc nulls last)
      )[1]::bigint`,
    })
    .from(schema.transactions)
    .where(where)
    .groupBy(schema.transactions.txnDate)
    .orderBy(schema.transactions.txnDate);

  return rows
    .filter((r) => r.balancePaise != null)
    .map((r) => ({
      date: r.date,
      balancePaise: Number(r.balancePaise),
    }));
}

export interface TopCounterparty {
  counterpartyId: string;
  displayName: string;
  netSelfPaise: number;
  count: number;
}

export async function topCounterparties(
  accountId: string,
  from: string | null,
  to: string | null,
  limit = 10,
): Promise<TopCounterparty[]> {
  const where = buildWhere(accountId, from, to);
  const rows = await db
    .select({
      counterpartyId: schema.transactions.counterpartyId,
      displayName: schema.counterparties.displayName,
      key: schema.counterparties.key,
      netSelf: sql<number>`coalesce(sum(${netSelfExpr}), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.transactions)
    .innerJoin(
      schema.counterparties,
      eq(schema.transactions.counterpartyId, schema.counterparties.id),
    )
    .where(where)
    .groupBy(
      schema.transactions.counterpartyId,
      schema.counterparties.displayName,
      schema.counterparties.key,
    );

  return rows
    .map((r) => ({
      counterpartyId: r.counterpartyId!,
      displayName: r.displayName ?? r.key,
      netSelfPaise: Number(r.netSelf),
      count: r.count,
    }))
    .filter((r) => r.netSelfPaise > 0)
    .sort((a, b) => b.netSelfPaise - a.netSelfPaise)
    .slice(0, limit);
}
