import { desc, eq, and, lte, gte } from "drizzle-orm";
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

/** Default spend report period: current calendar month. */
export async function resolveSpendPeriod(
  accountId: string,
  sp: SpendSearchParams,
): Promise<ResolvedSpendPeriod> {
  if (sp.statement === "1" || sp.statement === "true") {
    return resolveStatementPeriod(accountId);
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

/** Timeline default: latest statement period; falls back like spend when none imported. */
export async function resolveTimelinePeriod(
  accountId: string,
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
    return resolveStatementPeriod(accountId);
  }

  return resolveSpendPeriod(accountId, sp);
}

async function resolveStatementPeriod(
  accountId: string,
): Promise<ResolvedSpendPeriod> {
  const period = await getLatestStatementPeriod(accountId);
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

/** Statement import whose date range contains txnDate, or null. */
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

/** Latest imported statement date range, or null if none. */
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
