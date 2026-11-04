import { desc, eq, and, lte, gte } from "drizzle-orm";
import { db, schema } from "@/db";
import { indiaCivilDate, indiaTodayIso, parseMonthKey } from "@/lib/dates/india";
import {
  calendarMonthPeriod,
  type Period,
  PRESET_PERIODS,
  resolvePeriod,
} from "@/lib/period";
import type { SpendSearchParams } from "@/lib/spend/period-href";

export {
  adjacentMonthHref,
  reimbursementsPeriodHref,
  spendPeriodHref,
} from "@/lib/spend/period-href";
export type { SpendSearchParams } from "@/lib/spend/period-href";

export type SpendPeriodMode = "month" | "statement" | "preset" | "custom";

export interface ResolvedSpendPeriod {
  period: Period;
  mode: SpendPeriodMode;
  /** YYYY-MM when mode is month */
  monthKey?: string;
  isPartial: boolean;
}

export async function resolveSpendPeriod(
  accountId: string,
  sp: SpendSearchParams,
  now: Date = new Date(),
): Promise<ResolvedSpendPeriod> {
  const today = indiaTodayIso(now);
  if (sp.statement === "1" || sp.statement === "true") {
    return resolveStatementPeriod(accountId, now);
  }

  if (sp.preset && PRESET_PERIODS[sp.preset]) {
    const p = PRESET_PERIODS[sp.preset](now);
    return {
      period: p,
      mode: "preset",
      isPartial: p.to < today,
    };
  }

  const month = sp.month ? parseMonthKey(sp.month) : null;
  if (month) {
    const p = calendarMonthPeriod(month.year, month.month, now);
    return {
      period: p,
      mode: "month",
      monthKey: p.monthKey,
      isPartial: p.isPartial,
    };
  }

  if (sp.from || sp.to) {
    const p = resolvePeriod(sp);
    return {
      period: p,
      mode: "custom",
      isPartial: Boolean(p.to && p.to < today),
    };
  }

  const civil = indiaCivilDate(now);
  const p = calendarMonthPeriod(civil.year, civil.month, now);
  return {
    period: p,
    mode: "month",
    monthKey: p.monthKey,
    isPartial: p.isPartial,
  };
}

export async function resolveTimelinePeriod(
  accountId: string,
  sp: SpendSearchParams,
  now: Date = new Date(),
): Promise<ResolvedSpendPeriod> {
  const hasExplicit =
    sp.month ||
    sp.preset ||
    sp.from ||
    sp.to ||
    sp.statement === "1" ||
    sp.statement === "true";

  if (!hasExplicit) {
    return resolveStatementPeriod(accountId, now);
  }

  return resolveSpendPeriod(accountId, sp, now);
}

async function resolveStatementPeriod(
  accountId: string,
  now: Date,
): Promise<ResolvedSpendPeriod> {
  const period = await getLatestStatementPeriod(accountId);
  if (period) {
    return {
      period,
      mode: "statement",
      isPartial: period.to! < indiaTodayIso(now),
    };
  }

  const civil = indiaCivilDate(now);
  const p = calendarMonthPeriod(civil.year, civil.month, now);
  return {
    period: p,
    mode: "month",
    monthKey: p.monthKey,
    isPartial: p.isPartial,
  };
}

export async function getStatementPeriodForDate(
  accountId: string,
  txnDate: string,
): Promise<Period | null> {
  const [row] = await db
    .select({
      periodStart: schema.imports.periodStart,
      periodEnd: schema.imports.periodEnd,
    })
    .from(schema.imports)
    .where(
      and(
        eq(schema.imports.accountId, accountId),
        lte(schema.imports.periodStart, txnDate),
        gte(schema.imports.periodEnd, txnDate),
      ),
    )
    .orderBy(desc(schema.imports.createdAt))
    .limit(1);

  if (!row?.periodStart || !row?.periodEnd) return null;
  return {
    from: row.periodStart,
    to: row.periodEnd,
    label: `${row.periodStart} → ${row.periodEnd}`,
  };
}

export async function getLatestStatementPeriod(
  accountId: string,
): Promise<Period | null> {
  const [latest] = await db
    .select({
      periodStart: schema.imports.periodStart,
      periodEnd: schema.imports.periodEnd,
    })
    .from(schema.imports)
    .where(eq(schema.imports.accountId, accountId))
    .orderBy(desc(schema.imports.createdAt))
    .limit(1);

  if (!latest?.periodStart || !latest?.periodEnd) return null;
  return {
    from: latest.periodStart,
    to: latest.periodEnd,
    label: `${latest.periodStart} → ${latest.periodEnd}`,
  };
}

export async function listStatementPeriods(accountId: string) {
  const rows = await db
    .select({
      periodStart: schema.imports.periodStart,
      periodEnd: schema.imports.periodEnd,
    })
    .from(schema.imports)
    .where(eq(schema.imports.accountId, accountId))
    .orderBy(desc(schema.imports.createdAt));

  const seen = new Set<string>();
  return rows.filter(
    (r): r is { periodStart: string; periodEnd: string } => {
      if (r.periodStart == null || r.periodEnd == null) return false;
      const key = `${r.periodStart}\0${r.periodEnd}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );
}
