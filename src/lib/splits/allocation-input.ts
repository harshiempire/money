/**
 * Parsing for the amounts typed into the Settle dialog.
 *
 * Pure and client-safe so it can be unit-tested and so the dialog's live
 * totals, its Save gate and its submission all read from one result. The
 * previous path used parseFloat and dropped anything non-positive before
 * submitting, which meant "-10" was counted on screen but silently removed
 * from the save — clearing whatever allocation that row used to have.
 *
 * Grammar: up to twelve integer digits, optional point, at most two
 * decimals. Twelve digits keeps the paise value far inside the safe-integer
 * range by construction, so no BigInt is needed. Conversion is done on the
 * matched strings, never by multiplying a float (0.07 * 100 is not 7).
 */

import type { AllocationDraft } from "./validate";

export type ParsedRupees =
  | { kind: "blank" }
  | { kind: "paise"; paise: number }
  | { kind: "invalid" };

const RUPEES_RE = /^(\d{1,12})(?:\.(\d{0,2}))?$/;

export function parseRupees(raw: string): ParsedRupees {
  const text = raw.trim();
  if (text === "") return { kind: "blank" };
  const m = RUPEES_RE.exec(text);
  if (!m) return { kind: "invalid" };
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  return { kind: "paise", paise: whole * 100 + frac };
}

export interface AllocationProblem {
  splitParticipantId: string;
  raw: string;
  message: string;
}

export interface ParsedAllocations {
  ok: boolean;
  /** Rows that parsed to a positive amount. Blanks and zeros are omitted. */
  allocations: AllocationDraft[];
  /** Every entry that failed the grammar. Non-empty means `ok` is false. */
  problems: AllocationProblem[];
}

/**
 * `entries` is keyed by split participant id, values are the raw field text.
 * `labelFor` names the participant in a problem message.
 */
export function parseAllocationInputs(
  entries: Record<string, string>,
  labelFor: (splitParticipantId: string) => string = (id) => id,
): ParsedAllocations {
  const allocations: AllocationDraft[] = [];
  const problems: AllocationProblem[] = [];
  for (const [splitParticipantId, raw] of Object.entries(entries)) {
    const parsed = parseRupees(raw);
    if (parsed.kind === "blank") continue;
    if (parsed.kind === "invalid") {
      problems.push({
        splitParticipantId,
        raw,
        message: `${labelFor(splitParticipantId)}: "${raw.trim()}" isn't an amount — use digits and up to two decimals.`,
      });
      continue;
    }
    if (parsed.paise > 0) {
      allocations.push({ splitParticipantId, amountPaise: parsed.paise });
    }
  }
  return { ok: problems.length === 0, allocations, problems };
}
