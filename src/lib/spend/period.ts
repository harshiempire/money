import { desc, eq, and, lte, gte, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  calendarMonthPeriod,
  type Period,
  PRESET_PERIODS,
  resolvePeriod,
  shiftCalendarMonth,
} from "@/lib/period";

export type SpendPeriodMode = "month" | "statement" | "preset" | "custom";

export interface ResolvedSpendPeriod {
  period: Period;
  mode: SpendPeriodMode;
  /** YYYY-MM when mode is month */
  monthKey?: string;
  isPartial: boolean;
}

export interface SpendSearchParams {
  month?: string;
  from?: string;
  to?: string;
  preset?: string;
  statement?: string;
}

const MONTH_RE = /^\d{4}-\d{2}$/;

export function spendPeriodHref(
  sp: SpendSearchParams,
  base = "/spend",
): string {
  const q = new URLSearchParams();
  if (sp.month) q.set("month", sp.month);
  if (sp.preset) q.set("preset", sp.preset);
  if (sp.statement) q.set("statement", sp.statement);
  if (sp.from) q.set("from", sp.from);
  if (sp.to) q.set("to", sp.to);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

export function reimbursementsPeriodHref(sp: SpendSearchParams): string {
  return spendPeriodHref(sp, "/reimbursements");
}

export async function resolveSpendPeriod(
  accountIds: string[],
  sp: SpendSearchParams,
): Promise<ResolvedSpendPeriod> {
  if (sp.statement === "1" || sp.statement === "true") {
    return resolveStatementPeriod(accountIds);
  }

  if (sp.preset && PRESET_PERIODS[sp.preset]) {
    const p = PRESET_PERIODS[sp.preset]();
    return {
      period: p,
      mode: "preset",
      isPartial: p.to < todayIso(),
    };
  }

  if (sp.month && MONTH_RE.test(sp.month)) {
    const [y, m] = sp.month.split("-").map(Number);
    const p = calendarMonthPeriod(y, m);
    return {
      period: p,
      mode: "month",
      monthKey: sp.month,
      isPartial: p.isPartial,
    };
  }

  if (sp.from || sp.to) {
    const p = resolvePeriod(sp);
    return {
      period: p,
      mode: "custom",
      isPartial: Boolean(p.to && p.to < todayIso()),
    };
  }

  const now = new Date();
  const p = calendarMonthPeriod(now.getFullYear(), now.getMonth() + 1);
  return {
    period: p,
    mode: "month",
    monthKey: p.monthKey,
    isPartial: p.isPartial,
  };
}

export async function resolveTimelinePeriod(
  accountIds: string[],
  sp: SpendSearchParams,
): Promise<ResolvedSpendPeriod> {
  const hasExplicit =
    sp.month ||
    sp.preset ||
    sp.from ||
    sp.to ||
    sp.statement === "1" ||
    sp.statement === "true";

  if (!hasExplicit) {
    return resolveStatementPeriod(accountIds);
  }

  return resolveSpendPeriod(accountIds, sp);
}

async function resolveStatementPeriod(
  accountIds: string[],
): Promise<ResolvedSpendPeriod> {
  const period = await getLatestStatementPeriod(accountIds);
  if (period) {
    return {
      period,
      mode: "statement",
      isPartial: period.to! < todayIso(),
    };
  }

  const now = new Date();
  const p = calendarMonthPeriod(now.getFullYear(), now.getMonth() + 1);
  return {
    period: p,
    mode: "month",
    monthKey: p.monthKey,
    isPartial: p.isPartial,
  };
}

export async function getStatementPeriodForDate(
  accountIds: string[],
  txnDate: string,
): Promise<Period | null> {
  if (accountIds.length === 0) return null;
  const [row] = await db
    .select({
      periodStart: schema.imports.periodStart,
      periodEnd: schema.imports.periodEnd,
    })
    .from(schema.imports)
    .where(
      and(
        inArray(schema.imports.accountId, accountIds),
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
  accountIds: string[],
): Promise<Period | null> {
  if (accountIds.length === 0) return null;
  const [latest] = await db
    .select({
      periodStart: schema.imports.periodStart,
      periodEnd: schema.imports.periodEnd,
    })
    .from(schema.imports)
    .where(inArray(schema.imports.accountId, accountIds))
    .orderBy(desc(schema.imports.createdAt))
    .limit(1);

  if (!latest?.periodStart || !latest?.periodEnd) return null;
  return {
    from: latest.periodStart,
    to: latest.periodEnd,
    label: `${latest.periodStart} → ${latest.periodEnd}`,
  };
}

export async function listStatementPeriods(accountIds: string[]) {
  if (accountIds.length === 0) return [];
  const rows = await db
    .select({
      periodStart: schema.imports.periodStart,
      periodEnd: schema.imports.periodEnd,
    })
    .from(schema.imports)
    .where(inArray(schema.imports.accountId, accountIds))
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

export function adjacentMonthHref(
  monthKey: string,
  delta: -1 | 1,
  basePath = "/spend",
): string | null {
  if (!MONTH_RE.test(monthKey)) return null;
  const next = shiftCalendarMonth(monthKey, delta);
  return spendPeriodHref({ month: next }, basePath);
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
