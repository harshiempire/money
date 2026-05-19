/**
 * Resolve a period from query params. If both from and to are missing,
 * caller can fall back to the latest statement period.
 */
export interface Period {
  from: string | null;
  to: string | null;
  label: string;
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const today = () => iso(new Date());
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
};
const monthStart = () => {
  const d = new Date();
  d.setDate(1);
  return iso(d);
};

export const PRESET_PERIODS: Record<
  string,
  () => { from: string; to: string; label: string }
> = {
  this_month: () => ({
    from: monthStart(),
    to: today(),
    label: "This month",
  }),
  last_30: () => ({ from: daysAgo(30), to: today(), label: "Last 30 days" }),
  last_90: () => ({ from: daysAgo(90), to: today(), label: "Last 90 days" }),
};

export function resolvePeriod(sp: {
  from?: string;
  to?: string;
  preset?: string;
}): Period {
  if (sp.preset && PRESET_PERIODS[sp.preset]) {
    return PRESET_PERIODS[sp.preset]();
  }
  if (sp.from || sp.to) {
    return {
      from: sp.from ?? null,
      to: sp.to ?? null,
      label: `${sp.from ?? "…"} → ${sp.to ?? "…"}`,
    };
  }
  return { from: null, to: null, label: "All time" };
}

const parseIso = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** Inclusive day count between two ISO date strings. */
export function inclusiveDayCount(from: string, to: string): number {
  const ms = parseIso(to).getTime() - parseIso(from).getTime();
  return Math.max(1, Math.floor(ms / 86_400_000) + 1);
}

/** Shift a bounded period back by its own length (for period-over-period compare). */
export function previousPeriodWindow(
  from: string,
  to: string,
): { from: string; to: string; label: string } {
  const days = inclusiveDayCount(from, to);
  const prevTo = parseIso(from);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - (days - 1));
  const f = iso(prevFrom);
  const t = iso(prevTo);
  return { from: f, to: t, label: `${f} → ${t}` };
}
