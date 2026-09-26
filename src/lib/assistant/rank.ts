/**
 * Orders search results and says, in plain words, why each one matched.
 * Every reason is computed from the transaction row itself — nothing here is
 * model output — so the UI can label reasons as coming from Money data.
 */
import { daysBetween, type DateWindow } from "@/lib/dates/partial-date";
import { formatDate, formatPaise } from "@/lib/format";
import type { GroundedCriteria } from "./find-intent";

export interface CandidateRow {
  id: string;
  txnDate: string;
  amountPaise: number;
  drCr: "debit" | "credit";
  label: string;
  counterpartyDisplayName: string | null;
  channel: string;
  rawDescription: string;
  parsedPurpose: string | null;
  note: string | null;
}

export interface RankedCandidate {
  row: CandidateRow;
  score: number;
  reasons: string[];
}

export type MatchConfidence = "none" | "single" | "clear_best" | "ambiguous";

const has = (haystack: string | null, needle: string) =>
  haystack !== null && haystack.toLowerCase().includes(needle.toLowerCase());

function dateReason(txnDate: string, windows: DateWindow[]): { score: number; reason: string } | null {
  for (const w of windows) {
    if (txnDate < w.from || txnDate > w.to) continue;
    if (w.target === null) {
      return { score: 10, reason: `Dated ${formatDate(txnDate)}, inside the period you asked about` };
    }
    const diff = daysBetween(w.target, txnDate);
    if (diff === 0) return { score: 40, reason: `Dated ${formatDate(txnDate)}, the day you asked about` };
    const days = Math.abs(diff) === 1 ? "1 day" : `${Math.abs(diff)} days`;
    return {
      score: 40 - Math.abs(diff) * 8,
      reason: `Dated ${formatDate(txnDate)}, ${days} ${diff > 0 ? "after" : "before"} ${formatDate(w.target)}`,
    };
  }
  return null;
}

export function rankCandidates(
  criteria: GroundedCriteria,
  windows: DateWindow[],
  rows: CandidateRow[],
): { ranked: RankedCandidate[]; confidence: MatchConfidence } {
  const ranked = rows.map((row) => {
    let score = 0;
    const reasons: string[] = [];

    if (criteria.amountPaise !== null && row.amountPaise === criteria.amountPaise) {
      score += 50;
      reasons.push(`Amount is exactly ${formatPaise(row.amountPaise)}`);
    }

    const d = windows.length > 0 ? dateReason(row.txnDate, windows) : null;
    if (d) {
      score += d.score;
      reasons.push(d.reason);
    }

    if (criteria.text) {
      const where = [
        has(row.label, criteria.text) && "the payee",
        has(row.rawDescription, criteria.text) && !has(row.label, criteria.text) && "the bank description",
        has(row.parsedPurpose, criteria.text) && "the payment purpose",
        has(row.note, criteria.text) && "your note",
      ].filter(Boolean);
      if (where.length > 0) {
        score += 25;
        reasons.push(`"${criteria.text}" appears in ${where.join(" and ")}`);
      }
    }

    if (criteria.direction !== "any") {
      reasons.push(row.drCr === "debit" ? "Money you paid out" : "Money you received");
    }

    return { row, score, reasons };
  });

  ranked.sort((a, b) => b.score - a.score || (a.row.txnDate < b.row.txnDate ? 1 : -1));

  let confidence: MatchConfidence;
  if (ranked.length === 0) confidence = "none";
  else if (ranked.length === 1) confidence = "single";
  else if (ranked[0].score - ranked[1].score >= 20) confidence = "clear_best";
  else confidence = "ambiguous";

  return { ranked, confidence };
}
