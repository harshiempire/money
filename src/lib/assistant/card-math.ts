/**
 * Money arithmetic behind the assistant's pending cards. Pure and exact
 * (paise integers); runs both on the server (to prefill a card) and in the
 * browser (to validate edits live). The server actions re-validate on Apply.
 */
import { parseAmountToPaise } from "@/lib/money/parse-amount";
import type { NetLine } from "./types";

export const rupeesString = (paise: number) => (paise / 100).toFixed(2);

/** "" counts as zero; anything unreadable is NaN so the card can refuse it. */
export const typedPaise = (s: string): number => {
  if (!s.trim()) return 0;
  return parseAmountToPaise(s) ?? NaN;
};

/**
 * Equal shares between `people` participants and you. Remainder paise go to
 * you (as SplitDialog's "Equal split" does), so participants owe round-ish
 * amounts and the total always balances exactly.
 */
export function equalShares(totalPaise: number, people: number): { yours: number; each: number } {
  const n = people + 1;
  const each = Math.floor(totalPaise / n);
  return { yours: totalPaise - each * people, each };
}

export interface SplitBalance {
  participantsPaise: number;
  yourSharePaise: number;
  /** total − (yours + participants); 0 when balanced. */
  residualPaise: number;
  named: boolean;
  invalid: boolean;
  ok: boolean;
}

export function splitBalance(
  totalPaise: number,
  yourShare: string,
  parts: Array<{ name: string; amt: string }>,
): SplitBalance {
  let invalid = false;
  let participantsPaise = 0;
  let named = false;
  for (const p of parts) {
    if (!p.name.trim() || !p.amt.trim()) continue;
    const paise = typedPaise(p.amt);
    if (Number.isNaN(paise)) invalid = true;
    else {
      participantsPaise += paise;
      if (paise > 0) named = true;
    }
  }
  let yourSharePaise: number;
  if (yourShare.trim() === "") {
    yourSharePaise = Math.max(0, totalPaise - participantsPaise);
  } else {
    yourSharePaise = typedPaise(yourShare);
    if (Number.isNaN(yourSharePaise)) {
      invalid = true;
      yourSharePaise = 0;
    }
  }
  const residualPaise = totalPaise - (yourSharePaise + participantsPaise);
  return {
    participantsPaise,
    yourSharePaise,
    residualPaise,
    named,
    invalid,
    ok: !invalid && named && residualPaise === 0,
  };
}

/**
 * Matches a name the user said against people already in Money: exact
 * (case-insensitive), then a unique prefix. Unknown names are kept as said
 * and flagged, so the card can show "new person" instead of silently
 * creating one.
 */
export function resolvePerson(said: string, known: string[]): { name: string; known: boolean } {
  const s = said.trim();
  const lower = s.toLowerCase();
  const exact = known.find((k) => k.toLowerCase() === lower);
  if (exact) return { name: exact, known: true };
  if (lower.length >= 3) {
    const prefixed = known.filter((k) => k.toLowerCase().startsWith(lower));
    if (prefixed.length === 1) return { name: prefixed[0], known: true };
  }
  return { name: s, known: false };
}

export interface NetBalance {
  receivablePaise: number;
  payablePaise: number;
  /** (R − P) − inflow; 0 when balanced. */
  residualPaise: number;
  overLine: NetLine | null;
  invalid: boolean;
  ok: boolean;
}

export function netBalance(inflowPaise: number, recv: NetLine[], pay: NetLine[]): NetBalance {
  let invalid = false;
  let overLine: NetLine | null = null;
  const total = (lines: NetLine[]) =>
    lines.reduce((sum, l) => {
      const p = typedPaise(l.val);
      if (Number.isNaN(p) || p < 0) {
        invalid = true;
        return sum;
      }
      if (p > l.outstandingPaise && !overLine) overLine = l;
      return sum + p;
    }, 0);
  const receivablePaise = total(recv);
  const payablePaise = total(pay);
  const residualPaise = receivablePaise - payablePaise - inflowPaise;
  return {
    receivablePaise,
    payablePaise,
    residualPaise,
    overLine,
    invalid,
    ok: !invalid && !overLine && residualPaise === 0 && (receivablePaise > 0 || payablePaise > 0),
  };
}

/**
 * "Adjust to match bank (prefer largest receivable)": keeps payables as typed
 * and fills receivables largest-outstanding first until R − P equals the
 * inflow. Lines it doesn't need are left empty.
 */
export function fillReceivablesLargestFirst(inflowPaise: number, recv: NetLine[], pay: NetLine[]): NetLine[] {
  const payable = pay.reduce((s, l) => {
    const p = typedPaise(l.val);
    return s + (Number.isNaN(p) ? 0 : p);
  }, 0);
  let need = inflowPaise + payable;
  const order = recv.map((_, i) => i).sort((a, b) => recv[b].outstandingPaise - recv[a].outstandingPaise);
  const vals = recv.map(() => 0);
  for (const i of order) {
    const take = Math.max(0, Math.min(need, recv[i].outstandingPaise));
    vals[i] = take;
    need -= take;
  }
  return recv.map((l, i) => ({ ...l, val: vals[i] > 0 ? rupeesString(vals[i]) : "" }));
}
