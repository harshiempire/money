import "server-only";
import { type SQL, and, desc, eq, gte, lte, sql } from "drizzle-orm";
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
export const netSelfExpr = sql<number>`
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

export const txnMonthKeyExpr = sql<string>`to_char(date_trunc('month', ${schema.transactions.txnDate}::timestamp), 'YYYY-MM')`;

/** Shared debit/credit sum fragments — the single source of truth for the
 * gross debit/credit totals used across period totals and metrics queries. */
export const debitSumExpr = sql<number>`coalesce(sum(case when ${schema.transactions.drCr} = 'debit' then ${schema.transactions.amountPaise} else 0 end), 0)::bigint`;
export const creditSumExpr = sql<number>`coalesce(sum(case when ${schema.transactions.drCr} = 'credit' then ${schema.transactions.amountPaise} else 0 end), 0)::bigint`;

export interface NetSpendTotals {
  totalDebitPaise: number;
  totalCreditPaise: number;
  netSelfPaise: number;
  owedSelfPaise: number;
  count: number;
}

const buildTxnWhere = (
  accountId: string,
  from: string | null,
  to: string | null,
): SQL | undefined => {
  const filters = [eq(schema.transactions.accountId, accountId)];
  if (from) filters.push(gte(schema.transactions.txnDate, from));
  if (to) filters.push(lte(schema.transactions.txnDate, to));
  return and(...filters);
};

async function resolveAccountUserId(
  accountId: string,
  userId?: string | null,
): Promise<string | undefined> {
  if (userId) return userId;
  const [account] = await db
    .select({ userId: schema.moneyAccounts.userId })
    .from(schema.moneyAccounts)
    .where(eq(schema.moneyAccounts.id, accountId))
    .limit(1);
  return account?.userId;
}

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

export interface PeriodTxnMetrics {
  totalDebitPaise: number;
  totalCreditPaise: number;
  txnNetSelfPaise: number;
  count: number;
  personalDebitGrossPaise: number;
  yourShareDebitPaise: number;
  othersSharePaise: number;
  netCreditPaise: number;
  splitTxnCount: number;
  uncategorizedNetSelfPaise: number;
  uncategorizedCount: number;
  needsReviewCount: number;
  owedSelfPaise: number;
}

/** Single-pass period transaction metrics (net, bridge, triage). */
export async function loadPeriodTxnMetrics(
  accountId: string,
  from: string | null,
  to: string | null,
  userId?: string | null,
): Promise<PeriodTxnMetrics> {
  const where = buildTxnWhere(accountId, from, to);
  const resolvedUserId = await resolveAccountUserId(accountId, userId);

  const [r, splitCountRow, owedSelfPaise] = await Promise.all([
    db
      .select({
        debit: debitSumExpr,
        credit: creditSumExpr,
        netSelf: sql<number>`coalesce(sum(${netSelfExpr}), 0)::bigint`,
        count: sql<number>`count(*)::int`,
        personalDebitGross: sql<number>`coalesce(sum(${personalDebitGrossExpr}), 0)::bigint`,
        yourShareDebit: sql<number>`coalesce(sum(${yourShareDebitExpr}), 0)::bigint`,
        netCredit: sql<number>`coalesce(sum(${netCreditExpr}), 0)::bigint`,
        uncatNet: sql<number>`coalesce(sum(${netSelfExpr}) filter (where ${schema.transactions.categoryId} is null), 0)::bigint`,
        uncatCount: sql<number>`count(*) filter (where ${schema.transactions.categoryId} is null)::int`,
        reviewCount: sql<number>`count(*) filter (where ${schema.transactions.needsReview})::int`,
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
    resolvedUserId
      ? owedSelfPaiseForUser(resolvedUserId, from, to)
      : Promise.resolve(0),
  ]);

  const personalDebitGrossPaise = Number(r[0].personalDebitGross);
  const yourShareDebitPaise = Number(r[0].yourShareDebit);
  return {
    totalDebitPaise: Number(r[0].debit),
    totalCreditPaise: Number(r[0].credit),
    txnNetSelfPaise: Number(r[0].netSelf),
    count: r[0].count,
    personalDebitGrossPaise,
    yourShareDebitPaise,
    othersSharePaise: personalDebitGrossPaise - yourShareDebitPaise,
    netCreditPaise: Number(r[0].netCredit),
    splitTxnCount: splitCountRow[0]?.count ?? 0,
    uncategorizedNetSelfPaise: Number(r[0].uncatNet),
    uncategorizedCount: r[0].uncatCount,
    needsReviewCount: r[0].reviewCount,
    owedSelfPaise,
  };
}

/** Lean period totals — debit/credit/netSelf/count only, composed from the
 * same shared SQL fragments as loadPeriodTxnMetrics without paying for the
 * split-count join or the bridge/triage aggregates. */
export async function netSpendTotals(
  accountId: string,
  from: string | null,
  to: string | null,
  userId?: string | null,
): Promise<NetSpendTotals> {
  const where = buildTxnWhere(accountId, from, to);
  const resolvedUserId = await resolveAccountUserId(accountId, userId);

  const [[r], owedSelfPaise] = await Promise.all([
    db
      .select({
        debit: debitSumExpr,
        credit: creditSumExpr,
        netSelf: sql<number>`coalesce(sum(${netSelfExpr}), 0)::bigint`,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.transactions)
      .where(where),
    resolvedUserId
      ? owedSelfPaiseForUser(resolvedUserId, from, to)
      : Promise.resolve(0),
  ]);

  return {
    totalDebitPaise: Number(r.debit),
    totalCreditPaise: Number(r.credit),
    netSelfPaise: Number(r.netSelf) + owedSelfPaise,
    owedSelfPaise,
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
  userId?: string | null,
): Promise<CategoryRow[]> {
  const where = buildTxnWhere(accountId, from, to);
  const resolvedUserId = await resolveAccountUserId(accountId, userId);

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

  const owedRows = resolvedUserId
    ? await owedSpendByCategory(resolvedUserId, from, to)
    : [];

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
  const where = buildTxnWhere(accountId, from, to);
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
  const where = buildTxnWhere(accountId, from, to);
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

export interface SplitBridgeTotals {
  personalDebitGrossPaise: number;
  yourShareDebitPaise: number;
  othersSharePaise: number;
  netCreditPaise: number;
  splitTxnCount: number;
}

/** Decompose gross debits into your share vs others' share on split transactions. */
export async function splitBridgeTotals(
  accountId: string,
  from: string | null,
  to: string | null,
  userId?: string | null,
): Promise<SplitBridgeTotals> {
  const m = await loadPeriodTxnMetrics(accountId, from, to, userId);
  return {
    personalDebitGrossPaise: m.personalDebitGrossPaise,
    yourShareDebitPaise: m.yourShareDebitPaise,
    othersSharePaise: m.othersSharePaise,
    netCreditPaise: m.netCreditPaise,
    splitTxnCount: m.splitTxnCount,
  };
}

export interface TriageStats {
  uncategorizedNetSelfPaise: number;
  uncategorizedCount: number;
  needsReviewCount: number;
}

export async function triageStats(
  accountId: string,
  from: string | null,
  to: string | null,
  userId?: string | null,
): Promise<TriageStats> {
  const m = await loadPeriodTxnMetrics(accountId, from, to, userId);
  return {
    uncategorizedNetSelfPaise: m.uncategorizedNetSelfPaise,
    uncategorizedCount: m.uncategorizedCount,
    needsReviewCount: m.needsReviewCount,
  };
}

export interface DailyNetSpend {
  date: string;
  netSelfPaise: number;
}

/** Net personal spend per calendar day — for dashboard sparkline. */
export async function dailyNetSpend(
  accountId: string,
  from: string | null,
  to: string | null,
  userId?: string | null,
): Promise<DailyNetSpend[]> {
  const where = buildTxnWhere(accountId, from, to);
  const resolvedUserId = await resolveAccountUserId(accountId, userId);

  const [txnRows, owedRows] = await Promise.all([
    db
      .select({
        date: schema.transactions.txnDate,
        netSelf: sql<number>`coalesce(sum(${netSelfExpr}), 0)::bigint`,
      })
      .from(schema.transactions)
      .where(where)
      .groupBy(schema.transactions.txnDate),
    resolvedUserId
      ? (async () => {
          const filters = [eq(schema.owedExpenses.userId, resolvedUserId)];
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
        })()
      : Promise.resolve([] as Array<{ date: string; netSelf: number }>),
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

/** Largest personal debits by net-self amount (split-aware). */
export async function topDebits(
  accountId: string,
  from: string | null,
  to: string | null,
  limit = 5,
  userId?: string | null,
): Promise<TopDebit[]> {
  const where = buildTxnWhere(accountId, from, to);
  const resolvedUserId = await resolveAccountUserId(accountId, userId);

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
    resolvedUserId
      ? (async () => {
          const filters = [eq(schema.owedExpenses.userId, resolvedUserId)];
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
        })()
      : Promise.resolve(
          [] as Array<{
            id: string;
            txnDate: string;
            rawDescription: string;
            netSelf: number;
          }>,
        ),
  ]);

  // TODO: downstream UI links to /transactions#txn-${id}; owed_expense ids
  // won't resolve there. Revisit once we have a unified "expense" detail route.
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

export interface BulkMonthlyTxnMetrics {
  monthKey: string;
  txnNetSelfPaise: number;
  yourShareDebitPaise: number;
  othersSharePaise: number;
}

/** One scan of transactions grouped by calendar month. */
export async function loadBulkMonthlyTxnMetrics(
  accountId: string,
  from: string,
  to: string,
): Promise<Map<string, BulkMonthlyTxnMetrics>> {
  const where = buildTxnWhere(accountId, from, to);
  const rows = await db
    .select({
      monthKey: txnMonthKeyExpr,
      txnNetSelf: sql<number>`coalesce(sum(${netSelfExpr}), 0)::bigint`,
      yourShareDebit: sql<number>`coalesce(sum(${yourShareDebitExpr}), 0)::bigint`,
      personalDebitGross: sql<number>`coalesce(sum(${personalDebitGrossExpr}), 0)::bigint`,
    })
    .from(schema.transactions)
    .where(where)
    .groupBy(txnMonthKeyExpr);

  const map = new Map<string, BulkMonthlyTxnMetrics>();
  for (const r of rows) {
    const personalDebitGross = Number(r.personalDebitGross);
    const yourShareDebit = Number(r.yourShareDebit);
    map.set(r.monthKey, {
      monthKey: r.monthKey,
      txnNetSelfPaise: Number(r.txnNetSelf),
      yourShareDebitPaise: yourShareDebit,
      othersSharePaise: personalDebitGross - yourShareDebit,
    });
  }
  return map;
}

const owedMonthKeyExpr = sql<string>`to_char(date_trunc('month', ${schema.owedExpenses.incurredDate}::timestamp), 'YYYY-MM')`;

/** Owed expenses grouped by calendar month. */
export async function loadBulkMonthlyOwedSelf(
  userId: string,
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      monthKey: owedMonthKeyExpr,
      total: sql<number>`coalesce(sum(${schema.owedExpenses.amountPaise}), 0)::bigint`,
    })
    .from(schema.owedExpenses)
    .where(
      and(
        eq(schema.owedExpenses.userId, userId),
        gte(schema.owedExpenses.incurredDate, from),
        lte(schema.owedExpenses.incurredDate, to),
      ),
    )
    .groupBy(owedMonthKeyExpr);

  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.monthKey, Number(r.total));
  }
  return map;
}
