/**
 * Display helpers shared across pages. All money is paise (integer); dates
 * are ISO strings from Postgres `date` columns.
 */

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});

export const formatPaise = (paise: number | null | undefined): string => {
  if (paise == null) return "—";
  return inrFormatter.format(paise / 100);
};

/** Deterministic INR string (no Intl) — avoids SSR/client hydration mismatches in SVG. */
export const formatPaisePlain = (paise: number | null | undefined): string => {
  if (paise == null) return "—";
  const sign = paise < 0 ? "−" : "";
  const abs = Math.abs(paise);
  const rupees = Math.trunc(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  const rs = String(rupees);
  if (rs.length <= 3) return `${sign}₹${rs}.${cents}`;
  const last3 = rs.slice(-3);
  let rest = rs.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) groups.unshift(rest);
  return `${sign}₹${groups.join(",")},${last3}.${cents}`;
};

function stripTrailingDecimalZero(s: string): string {
  return s.replace(/\.0(?=[kLCr]|$)/, "");
}

/** Compact INR label for charts (deterministic, no Intl). */
export const formatPaiseShort = (
  paise: number | null | undefined,
): string => {
  if (paise == null) return "—";
  const sign = paise < 0 ? "−" : "";
  const rupees = Math.abs(paise) / 100;

  if (rupees < 1000) {
    return `${sign}₹${Math.round(rupees)}`;
  }
  if (rupees < 100_000) {
    const k = rupees / 1000;
    const formatted =
      k >= 100
        ? String(Math.round(k))
        : stripTrailingDecimalZero((Math.round(k * 10) / 10).toFixed(1));
    return `${sign}₹${formatted}k`;
  }
  if (rupees < 10_000_000) {
    const L = rupees / 100_000;
    return `${sign}₹${stripTrailingDecimalZero((Math.round(L * 10) / 10).toFixed(1))}L`;
  }
  const Cr = rupees / 10_000_000;
  return `${sign}₹${stripTrailingDecimalZero((Math.round(Cr * 10) / 10).toFixed(1))}Cr`;
};

export const formatPaiseSigned = (
  paise: number,
  drCr: "debit" | "credit",
): string => {
  const sign = drCr === "debit" ? "−" : "+";
  return `${sign} ${inrFormatter.format(paise / 100)}`;
};

export const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  // Treat YYYY-MM-DD as a calendar date, not a timestamp, so it doesn't shift
  // by timezone when rendered.
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
};

/**
 * Best-effort display label from the raw description. Falls back to a
 * truncated description so every row has *something* readable.
 */
export const counterpartyLabel = (raw: string): string => {
  const upi = raw.match(/^UPI\/\d+\/[\d:]+\/(?:UPI|UDIR)\/([^\s/]+)/i);
  if (upi) return upi[1].replace(/\s+/g, "").toLowerCase();
  const imps = raw.match(/^IMPS\/(?:P2A|P2P|P2M)\/\d+\/([^/]+?)(?:\/.*)?$/);
  if (imps) return imps[1].trim();
  const neft = raw.match(/^NEFT-[A-Z0-9]+-(.+?)(?:\s*-\s*)?$/);
  if (neft) return neft[1].trim();
  if (/Opening Balance/i.test(raw)) return "Opening Balance";
  return raw.length > 40 ? raw.slice(0, 40) + "…" : raw;
};
