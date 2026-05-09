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
