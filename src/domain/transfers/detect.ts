/**
 * Transfer-pair detection: a debit and a credit of the same amount within a
 * short window are almost always a self/family/investment round-trip
 * (Groww invest then withdraw, family P2P that returns, refund-reversal),
 * not real personal spend.
 *
 * Pure function over canonical row data so it's easy to test and reuse from
 * the server action. The caller filters and persists.
 */

export interface DetectInput {
  id: string;
  txnDate: string; // YYYY-MM-DD
  amountPaise: number;
  drCr: "debit" | "credit";
  channel: string;
  counterpartyId: string | null;
  isTransfer: boolean;
}

export interface DetectedPair {
  debitId: string;
  creditId: string;
  daysApart: number;
  channelMatch: boolean;
  counterpartyMatch: boolean;
}

const daysBetween = (a: string, b: string): number => {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  return Math.round(Math.abs(da - db) / (1000 * 60 * 60 * 24));
};

/**
 * Greedy pairing: for each unpaired debit, find the closest-in-date unpaired
 * credit of the exact same amount within `windowDays`. Prefers same-channel
 * and same-counterparty pairs to break ties.
 */
export function detectTransferPairs(
  rows: readonly DetectInput[],
  options: { windowDays?: number } = {},
): DetectedPair[] {
  const windowDays = options.windowDays ?? 3;
  const candidates = rows.filter((r) => !r.isTransfer);
  const debits = candidates.filter((r) => r.drCr === "debit");
  const credits = candidates.filter((r) => r.drCr === "credit");
  const used = new Set<string>();
  const pairs: DetectedPair[] = [];

  for (const d of debits) {
    let best: { c: DetectInput; days: number; score: number } | null = null;
    for (const c of credits) {
      if (used.has(c.id)) continue;
      if (c.amountPaise !== d.amountPaise) continue;
      const days = daysBetween(d.txnDate, c.txnDate);
      if (days > windowDays) continue;
      const channelMatch = c.channel === d.channel;
      const counterpartyMatch =
        d.counterpartyId != null &&
        c.counterpartyId != null &&
        d.counterpartyId === c.counterpartyId;
      // Prefer closer-in-date, then channel match, then counterparty match.
      const score =
        days * 100 - (channelMatch ? 5 : 0) - (counterpartyMatch ? 10 : 0);
      if (best === null || score < best.score) {
        best = { c, days, score };
      }
    }
    if (best) {
      used.add(best.c.id);
      pairs.push({
        debitId: d.id,
        creditId: best.c.id,
        daysApart: best.days,
        channelMatch: best.c.channel === d.channel,
        counterpartyMatch:
          d.counterpartyId != null &&
          best.c.counterpartyId != null &&
          d.counterpartyId === best.c.counterpartyId,
      });
    }
  }
  return pairs;
}
