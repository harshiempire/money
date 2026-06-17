import "server-only";
import { type SQL, and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db";

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
  owedSelfPaise: number;
  count: number;
}

const buildTxnWhere = (
  accountIds: string[],
  from: string | null,
  to: string | null,
): SQL | undefined => {
  if (accountIds.length === 0) return sql`false`;
  const filters: SQL[] = [inArray(schema.transactions.accountId, accountIds)];
  if (from) filters.push(gte(schema.transactions.txnDate, from));
  if (to) filters.push(lte(schema.transactions.txnDate, to));
  return and(...filters);
};

async function owedSelfPaiseForUser(
  userId: string,
  from: string | null,
  to: string | null,
): Promise<number> {
  const filters = [eq(schema.owedExpenses.userId, userId)];
  if (from) filters.push(gte(schema.owedExpenses.incurredDate, from));
  if (to) filters.push(lte(schema.owedExpenses.incurredDate, to));
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${schema.owedExpenses.amountPaise}), 0)::bigint`,
    })
    .from(schema.owedExpenses)
    .where(and(...filters));
  return Number(row.total);
}

async function owedSpendByCategory(
  userId: string,
  from: string | null,
  to: string | null,
): Promise<CategoryRow[]> {
  const filters = [eq(schema.owedExpenses.userId, userId)];
  if (from) filters.push(gte(schema.owedExpenses.incurredDate, from));
  if (to) filters.push(lte(schema.owedExpenses.incurredDate, to));

  const rows = await db
    .select({
      categoryId: schema.owedExpenses.categoryId,
      categoryName: schema.categories.name,
      total: sql<number>`coalesce(sum(${schema.owedExpenses.amountPaise}), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.owedExpenses)
    .leftJoin(
      schema.categories,
      eq(schema.owedExpenses.categoryId, schema.categories.id),
    )
    .where(and(...filters))
    .groupBy(schema.owedExpenses.categoryId, schema.categories.name);

  return rows.map((r) => ({
    categoryId: r.categoryId,
    categoryName: r.categoryName ?? "Uncategorized",
    netSelfPaise: Number(r.total),
    count: r.count,
  }));
}

export async function netSpendTotals(
  accountIds: string[],
  from: string | null,
  to: string | null,
  userId: string,
): Promise<NetSpendTotals> {
  if (accountIds.length === 0) {
    return { totalDebitPaise: 0, totalCreditPaise: 0, netSelfPaise: 0, owedSelfPaise: 0, count: 0 };
  }
  const where = buildTxnWhere(accountIds, from, to);

  const [r, owedSelfPaise] = await Promise.all([
    db
      .select({
        debit: sql<number>`coalesce(sum(case when ${schema.transactions.drCr} = 'debit' then ${schema.transactions.amountPaise} else 0 end), 0)::bigint`,
        credit: sql<number>`coalesce(sum(case when ${schema.transactions.drCr} = 'credit' then ${schema.transactions.amountPaise} else 0 end), 0)::bigint`,
        netSelf: sql<number>`coalesce(sum(${netSelfExpr}), 0)::bigint`,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.transactions)
      .where(where),
    owedSelfPaiseForUser(userId, from, to),
  ]);

  const txnNetSelf = Number(r[0].netSelf);
  return {
    totalDebitPaise: Number(r[0].debit),
    totalCreditPaise: Number(r[0].credit),
    netSelfPaise: txnNetSelf + owedSelfPaise,
    owedSelfPaise,
    count: r[0].count,
  };
}

export interface CategoryRow {
  categoryId: string | null;
  categoryName: string;
  netSelfPaise: number;
  count: number;
}

export async function categoryBreakdown(
  accountIds: string[],
  from: string | null,
  to: string | null,
  userId: string,
): Promise<CategoryRow[]> {
  if (accountIds.length === 0) return [];
  const where = buildTxnWhere(accountIds, from, to);

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

  const txnRows = rows.map((r) => ({
    categoryId: r.categoryId,
    categoryName: r.categoryName ?? "Uncategorized",
    netSelfPaise: Number(r.netSelf),
    count: r.count,
  }));

  const owedRows = await owedSpendByCategory(userId, from, to);

  const merged = new Map<string, CategoryRow>();
  for (const row of [...txnRows, ...owedRows]) {
    const key = row.categoryId ?? `uncat:${row.categoryName}`;
    const existing = merged.get(key) ?? {
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      netSelfPaise: 0,
      count: 0,
    };
    existing.netSelfPaise += row.netSelfPaise;
    existing.count += row.count;
    merged.set(key, existing);
  }

  return [...merged.values()]
    .filter((r) => r.netSelfPaise !== 0)
    .sort((a, b) => b.netSelfPaise - a.netSelfPaise);
}

export interface DailyBalance {
  date: string;
  balancePaise: number;
}

export async function dailyClosingBalance(
  accountIds: string[],
  from: string | null,
  to: string | null,
): Promise<DailyBalance[]> {
  if (accountIds.length === 0) return [];
  const where = buildTxnWhere(accountIds, from, to);
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
  accountIds: string[],
  from: string | null,
  to: string | null,
  limit = 10,
): Promise<TopCounterparty[]> {
  if (accountIds.length === 0) return [];
  const where = buildTxnWhere(accountIds, from, to);
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

const yourShareDebitExpr = sql<number>`
  case
    when ${schema.transactions.isTransfer} = true then 0
    when ${schema.transactions.drCr} = 'debit'
      then coalesce(
        (select ${schema.splits.yourSharePaise} from ${schema.splits}
         where ${schema.splits.transactionId} = ${schema.transactions.id}),
        ${schema.transactions.amountPaise}
      )
    else 0
  end
`;

const personalDebitGrossExpr = sql<number>`
  case
    when ${schema.transactions.isTransfer} = true then 0
    when ${schema.transactions.drCr} = 'debit'
      then ${schema.transactions.amountPaise}
    else 0
  end
`;

const netCreditExpr = sql<number>`
  case
    when ${schema.transactions.isTransfer} = true then 0
    when ${schema.transactions.drCr} = 'credit'
      and exists (
        select 1 from ${schema.settlements}
        where ${schema.settlements.inflowTransactionId} = ${schema.transactions.id}
      )
      then 0
    when ${schema.transactions.drCr} = 'credit'
      then ${schema.transactions.amountPaise}
    else 0
  end
`;

export interface SplitBridgeTotals {
  personalDebitGrossPaise: number;
  yourShareDebitPaise: number;
  othersSharePaise: number;
  netCreditPaise: number;
  splitTxnCount: number;
}

export async function splitBridgeTotals(
  accountIds: string[],
  from: string | null,
  to: string | null,
): Promise<SplitBridgeTotals> {
  if (accountIds.length === 0) {
    return { personalDebitGrossPaise: 0, yourShareDebitPaise: 0, othersSharePaise: 0, netCreditPaise: 0, splitTxnCount: 0 };
  }
  const where = buildTxnWhere(accountIds, from, to);
  const [r, splitCountRow] = await Promise.all([
    db
      .select({
        personalDebitGross: sql<number>`coalesce(sum(${personalDebitGrossExpr}), 0)::bigint`,
        yourShareDebit: sql<number>`coalesce(sum(${yourShareDebitExpr}), 0)::bigint`,
        netCredit: sql<number>`coalesce(sum(${netCreditExpr}), 0)::bigint`,
      })
      .from(schema.transactions)
      .where(where),
    db
      .select({
        count: sql<number>`count(distinct ${schema.splits.transactionId})::int`,
      })
      .from(schema.splits)
      .innerJoin(
        schema.transactions,
        eq(schema.splits.transactionId, schema.transactions.id),
      )
      .where(
        and(
          where,
          eq(schema.transactions.drCr, "debit"),
          eq(schema.transactions.isTransfer, false),
        ),
      ),
  ]);

  const personalDebitGrossPaise = Number(r[0].personalDebitGross);
  const yourShareDebitPaise = Number(r[0].yourShareDebit);
  return {
    personalDebitGrossPaise,
    yourShareDebitPaise,
    othersSharePaise: personalDebitGrossPaise - yourShareDebitPaise,
    netCreditPaise: Number(r[0].netCredit),
    splitTxnCount: splitCountRow[0]?.count ?? 0,
  };
}

export interface TriageStats {
  uncategorizedNetSelfPaise: number;
  uncategorizedCount: number;
  needsReviewCount: number;
}

export async function triageStats(
  accountIds: string[],
  from: string | null,
  to: string | null,
): Promise<TriageStats> {
  if (accountIds.length === 0) {
    return { uncategorizedNetSelfPaise: 0, uncategorizedCount: 0, needsReviewCount: 0 };
  }
  const where = buildTxnWhere(accountIds, from, to);
  const [uncat] = await db
    .select({
      netSelf: sql<number>`coalesce(sum(${netSelfExpr}), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.transactions)
    .where(and(where, isNull(schema.transactions.categoryId)));

  const [review] = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(schema.transactions)
    .where(and(where, eq(schema.transactions.needsReview, true)));

  return {
    uncategorizedNetSelfPaise: Number(uncat.netSelf),
    uncategorizedCount: uncat.count,
    needsReviewCount: review.count,
  };
}

export interface DailyNetSpend {
  date: string;
  netSelfPaise: number;
}

export async function dailyNetSpend(
  accountIds: string[],
  from: string | null,
  to: string | null,
  userId: string,
): Promise<DailyNetSpend[]> {
  if (accountIds.length === 0) return [];
  const where = buildTxnWhere(accountIds, from, to);

  const [txnRows, owedRows] = await Promise.all([
    db
      .select({
        date: schema.transactions.txnDate,
        netSelf: sql<number>`coalesce(sum(${netSelfExpr}), 0)::bigint`,
      })
      .from(schema.transactions)
      .where(where)
      .groupBy(schema.transactions.txnDate),
    (async () => {
      const filters = [eq(schema.owedExpenses.userId, userId)];
      if (from) filters.push(gte(schema.owedExpenses.incurredDate, from));
      if (to) filters.push(lte(schema.owedExpenses.incurredDate, to));
      return db
        .select({
          date: schema.owedExpenses.incurredDate,
          netSelf: sql<number>`coalesce(sum(${schema.owedExpenses.amountPaise}), 0)::bigint`,
        })
        .from(schema.owedExpenses)
        .where(and(...filters))
        .groupBy(schema.owedExpenses.incurredDate);
    })(),
  ]);

  const merged = new Map<string, number>();
  for (const r of txnRows) {
    merged.set(r.date, (merged.get(r.date) ?? 0) + Number(r.netSelf));
  }
  for (const r of owedRows) {
    merged.set(r.date, (merged.get(r.date) ?? 0) + Number(r.netSelf));
  }

  return [...merged.entries()]
    .map(([date, netSelfPaise]) => ({ date, netSelfPaise }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface TopDebit {
  id: string;
  txnDate: string;
  rawDescription: string;
  netSelfPaise: number;
}

export async function topDebits(
  accountIds: string[],
  from: string | null,
  to: string | null,
  userId: string,
  limit = 5,
): Promise<TopDebit[]> {
  if (accountIds.length === 0) return [];
  const where = buildTxnWhere(accountIds, from, to);

  const [txnRows, owedRows] = await Promise.all([
    db
      .select({
        id: schema.transactions.id,
        txnDate: schema.transactions.txnDate,
        rawDescription: schema.transactions.rawDescription,
        netSelf: yourShareDebitExpr,
      })
      .from(schema.transactions)
      .where(
        and(
          where,
          eq(schema.transactions.drCr, "debit"),
          eq(schema.transactions.isTransfer, false),
        ),
      )
      .orderBy(desc(yourShareDebitExpr))
      .limit(limit),
    (async () => {
      const filters = [eq(schema.owedExpenses.userId, userId)];
      if (from) filters.push(gte(schema.owedExpenses.incurredDate, from));
      if (to) filters.push(lte(schema.owedExpenses.incurredDate, to));
      return db
        .select({
          id: schema.owedExpenses.id,
          txnDate: schema.owedExpenses.incurredDate,
          rawDescription: schema.owedExpenses.description,
          netSelf: schema.owedExpenses.amountPaise,
        })
        .from(schema.owedExpenses)
        .where(and(...filters))
        .orderBy(desc(schema.owedExpenses.amountPaise))
        .limit(limit);
    })(),
  ]);

  const combined: TopDebit[] = [
    ...txnRows.map((r) => ({
      id: r.id,
      txnDate: r.txnDate,
      rawDescription: r.rawDescription,
      netSelfPaise: Number(r.netSelf),
    })),
    ...owedRows.map((r) => ({
      id: r.id,
      txnDate: r.txnDate,
      rawDescription: r.rawDescription,
      netSelfPaise: Number(r.netSelf),
    })),
  ];

  return combined
    .filter((r) => r.netSelfPaise > 0)
    .sort((a, b) => b.netSelfPaise - a.netSelfPaise)
    .slice(0, limit);
}
