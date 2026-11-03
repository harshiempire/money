/**
 * Split dialog form logic: initial values, the live balance check, the equal
 * split, the "your share" auto-suggestion and the `createSplit` payload.
 *
 * Plain functions over the form's string values, so they can be unit-tested
 * without React. No Effect import: this runs in the browser bundle.
 *
 * Amounts are typed as rupee strings and converted to integer paise here.
 * The conversions deliberately match what the dialog has always done
 * (`parseFloat` × 100, rounded), including how blank and non-numeric input
 * behaves; the server's own validation is the final word on amounts.
 */
import { formatPaise } from "@/lib/format";

export interface SplitFormParticipant {
  /** Existing participant id, kept so its row (and settlements) survive an edit. */
  id?: string;
  personName: string;
  expectedRupees: string;
}

export interface SplitFormValues {
  yourShare: string;
  note: string;
  participants: SplitFormParticipant[];
}

/** The parts of an existing split the form is prefilled from. */
export interface SplitFormExisting {
  yourSharePaise: number;
  note: string | null;
  participants: ReadonlyArray<{
    id: string;
    personName: string;
    expectedAmountPaise: number;
    settledAmountPaise?: number;
  }>;
}

/** Saved values and settlement warnings that a reopened form must reflect. */
export function splitFormSignature(existing: SplitFormExisting | null): string {
  return JSON.stringify(
    existing === null
      ? null
      : [
          existing.yourSharePaise,
          existing.note,
          existing.participants.map((p) => [
            p.id,
            p.personName,
            p.expectedAmountPaise,
            p.settledAmountPaise ?? 0,
          ]),
        ],
  );
}

/** Exactly what the dialog sends to `createSplit`. */
export interface CreateSplitPayload {
  transactionId: string;
  totalPaise: number;
  yourSharePaise: number;
  note: string | null;
  participants: Array<{
    id: string | undefined;
    personName: string;
    expectedAmountPaise: number;
  }>;
}

export const paiseToRupeesStr = (p: number): string => (p / 100).toFixed(2);
export const rupeesToPaise = (r: string): number =>
  Math.round(Number.parseFloat(r) * 100);

const blankParticipant = (): SplitFormParticipant => ({
  personName: "",
  expectedRupees: "",
});

export function initialSplitFormValues(
  existing: SplitFormExisting | null,
): SplitFormValues {
  return {
    yourShare: existing ? paiseToRupeesStr(existing.yourSharePaise) : "",
    note: existing?.note ?? "",
    participants:
      existing && existing.participants.length > 0
        ? existing.participants.map((p) => ({
            id: p.id,
            personName: p.personName,
            expectedRupees: paiseToRupeesStr(p.expectedAmountPaise),
          }))
        : [blankParticipant()],
  };
}

export const newParticipantRow = blankParticipant;

/**
 * Suggested "your share" when a new split's share is still blank and the
 * number of rows changes: total / (1 + named participants), rounded to paise.
 * Returns null when nothing should change.
 */
export function autoSuggestYourShare(
  values: SplitFormValues,
  totalRupees: string,
  hasExistingSplit: boolean,
): string | null {
  if (hasExistingSplit || values.yourShare !== "" || totalRupees === "") {
    return null;
  }
  const t = Number.parseFloat(totalRupees);
  const n = values.participants.filter((p) => p.personName).length + 1;
  if (n > 1 && Number.isFinite(t)) return (t / n).toFixed(2);
  return null;
}

/**
 * Divide the total equally between you and every named participant, in
 * paise. The indivisible remainder goes to your own share, so the parts
 * always sum back to the total: splitting ₹1000 three ways as 333.33 each
 * would leave a paise stranded and trip the balance invariant. Rows without
 * a name are dropped. Returns null when there is nobody to split with.
 */
export function equalSplitValues(
  values: SplitFormValues,
  totalRupees: string,
): Pick<SplitFormValues, "yourShare" | "participants"> | null {
  const totalP = rupeesToPaise(totalRupees);
  const named = values.participants.filter((p) => p.personName.trim());
  const n = named.length + 1;
  if (!Number.isFinite(totalP) || n <= 1) return null;
  const base = Math.floor(totalP / n);
  const remainder = totalP - base * n;
  return {
    yourShare: paiseToRupeesStr(base + remainder),
    participants: named.map((p) => ({
      id: p.id,
      personName: p.personName,
      expectedRupees: paiseToRupeesStr(base),
    })),
  };
}

export interface SplitBalance {
  totalPaise: number;
  totalValid: boolean;
  /** "Your share" as typed, or total − participants when left blank. */
  effectiveYourSharePaise: number;
  participantsSumPaise: number;
  /** total − (your share + participants); 0 when balanced. */
  residualPaise: number;
  isBalanced: boolean;
}

/**
 * Live balance check. Mirrors the server's invariant (your share +
 * participants === total) so Save can be disabled before the round-trip.
 * A blank "your share" auto-computes as total − participants, the same as
 * the payload, which balances by construction. Only rows with both a name
 * and an amount count.
 */
export function computeSplitBalance(
  values: SplitFormValues,
  totalRupees: string,
): SplitBalance {
  const totalPaise = rupeesToPaise(totalRupees);
  const totalValid = Number.isFinite(totalPaise);
  const yourSharePaiseLive =
    values.yourShare.trim() === "" ? null : rupeesToPaise(values.yourShare);
  const participantsSumPaise = values.participants
    .filter((p) => p.personName.trim() && p.expectedRupees.trim())
    .reduce((s, p) => {
      const v = rupeesToPaise(p.expectedRupees);
      return s + (Number.isFinite(v) ? v : 0);
    }, 0);
  const effectiveYourSharePaise =
    yourSharePaiseLive != null && Number.isFinite(yourSharePaiseLive)
      ? yourSharePaiseLive
      : totalValid
        ? Math.max(0, totalPaise - participantsSumPaise)
        : 0;
  const residualPaise = totalValid
    ? totalPaise - (effectiveYourSharePaise + participantsSumPaise)
    : 0;
  return {
    totalPaise,
    totalValid,
    effectiveYourSharePaise,
    participantsSumPaise,
    residualPaise,
    isBalanced: totalValid && residualPaise === 0,
  };
}

/**
 * The dialog-level validation message, shown in brackets after the balance
 * line ("unaccounted ₹1.00" / "over by ₹1.00"). Undefined when balanced.
 */
export function splitBalanceError(balance: SplitBalance): string | undefined {
  if (balance.isBalanced) return undefined;
  const label =
    balance.residualPaise >= 0 || !balance.totalValid
      ? "unaccounted"
      : "over by";
  return `${label} ${formatPaise(Math.abs(balance.residualPaise))}`;
}

export const validateSplitForm = (
  values: SplitFormValues,
  totalRupees: string,
): string | undefined =>
  splitBalanceError(computeSplitBalance(values, totalRupees));

/**
 * Build the `createSplit` input. Rows missing a name or an amount are left
 * out. A blank "your share" defaults to total − named participant shares
 * ("I paid the rest"), and to 0 if the maths goes sideways.
 */
export function buildCreateSplitPayload(
  values: SplitFormValues,
  context: { transactionId: string; totalRupees: string },
): CreateSplitPayload {
  const participants = values.participants
    .filter((p) => p.personName.trim() && p.expectedRupees.trim())
    .map((p) => ({
      id: p.id,
      personName: p.personName.trim(),
      expectedAmountPaise: rupeesToPaise(p.expectedRupees),
    }));
  const totalPaise = rupeesToPaise(context.totalRupees);
  let yourSharePaise = rupeesToPaise(values.yourShare);
  if (!Number.isFinite(yourSharePaise)) {
    const participantsSum = participants.reduce(
      (s, p) => s + p.expectedAmountPaise,
      0,
    );
    yourSharePaise = Number.isFinite(totalPaise)
      ? Math.max(0, totalPaise - participantsSum)
      : 0;
  }
  return {
    transactionId: context.transactionId,
    totalPaise: Number.isFinite(totalPaise) ? totalPaise : 0,
    yourSharePaise,
    note: values.note.trim() || null,
    participants,
  };
}
