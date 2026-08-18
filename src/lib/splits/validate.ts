/**
 * Pure validation for split and settlement writes.
 *
 * These live outside the server actions so they can be tested without a
 * database — the actions stay responsible for the reads (what is already
 * settled, what the inflow is) and call in here to decide.
 */

export interface ParticipantDraft {
  id?: string;
  personName: string;
  expectedAmountPaise: number;
}

export interface AllocationDraft {
  splitParticipantId: string;
  amountPaise: number;
}

export type Validation = { ok: true } | { ok: false; message: string };

const OK: Validation = { ok: true };
const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

const isWholeNonNegative = (n: number): boolean =>
  Number.isFinite(n) && Number.isInteger(n) && n >= 0;

/**
 * Money is stored as unsigned paise. A negative share still satisfies the
 * balance equation (total 100 = your 200 + participant −100) while making
 * your recorded spend larger than the transaction, so sign has to be
 * rejected before the balance check ever runs.
 */
export function validateSplitAmounts(input: {
  totalPaise: number;
  yourSharePaise: number;
  participants: ParticipantDraft[];
}): Validation {
  if (!isWholeNonNegative(input.totalPaise)) {
    return { ok: false, message: "Split total must be a positive amount." };
  }
  if (!isWholeNonNegative(input.yourSharePaise)) {
    return { ok: false, message: "Your share must be a positive amount." };
  }
  for (const p of input.participants) {
    if (!isWholeNonNegative(p.expectedAmountPaise)) {
      return {
        ok: false,
        message: `${p.personName || "A participant"}'s share must be a positive amount.`,
      };
    }
  }
  return OK;
}

/**
 * The write path reconciles kept participants into a Map keyed by id, so a
 * repeated id silently collapses: two rows totalling the balanced amount get
 * written as whichever one landed last, and the stored split no longer adds up.
 */
export function validateNoDuplicateParticipants(
  participants: ParticipantDraft[],
): Validation {
  const seen = new Set<string>();
  for (const p of participants) {
    if (!p.id) continue;
    if (seen.has(p.id)) {
      return {
        ok: false,
        message: `${p.personName || "A participant"} appears twice in this split. Each person may only have one share.`,
      };
    }
    seen.add(p.id);
  }
  return OK;
}

/** total === your share + Σ participants, to the paise. */
export function validateSplitBalances(input: {
  totalPaise: number;
  yourSharePaise: number;
  participants: ParticipantDraft[];
}): Validation {
  const participantsSum = input.participants.reduce(
    (s, p) => s + p.expectedAmountPaise,
    0,
  );
  const parts = input.yourSharePaise + participantsSum;
  if (parts !== input.totalPaise) {
    const unaccounted = Math.abs(input.totalPaise - parts);
    return {
      ok: false,
      message: `Split doesn't balance: your share ${rupees(input.yourSharePaise)} + participants ${rupees(participantsSum)} = ${rupees(parts)}, but total is ${rupees(input.totalPaise)} (${rupees(unaccounted)} unaccounted).`,
    };
  }
  return OK;
}

export function validateSplitInput(input: {
  totalPaise: number;
  yourSharePaise: number;
  participants: ParticipantDraft[];
}): Validation {
  const amounts = validateSplitAmounts(input);
  if (!amounts.ok) return amounts;
  const dupes = validateNoDuplicateParticipants(input.participants);
  if (!dupes.ok) return dupes;
  return validateSplitBalances(input);
}

/**
 * A settlement records money arriving. Ownership alone doesn't establish that:
 * without this, passing a debit's id settles a receivable — and can mint an
 * overpayment payable — for money that never came in.
 */
export function validateSettlementSource(
  drCr: "debit" | "credit" | null | undefined,
): Validation {
  if (drCr !== "credit") {
    return {
      ok: false,
      message:
        "Only an incoming credit can settle a share — this transaction isn't money arriving.",
    };
  }
  return OK;
}

export function validateAllocationAmounts(
  allocations: AllocationDraft[],
): Validation {
  for (const a of allocations) {
    if (!isWholeNonNegative(a.amountPaise)) {
      return { ok: false, message: "Allocation amounts must be positive." };
    }
  }
  return OK;
}

/**
 * Re-saving a settlement replaces whatever the leftover was previously decided
 * to be, which means deleting the payable an overpayment created. That payable
 * may itself have been repaid, and deleting it would cascade those repayment
 * records away — so refuse instead, the same way removing a settled
 * participant is refused.
 */
export function validatePayableReplaceable(payable: {
  personName: string;
  settledPaise: number;
}): Validation {
  if (payable.settledPaise > 0) {
    return {
      ok: false,
      message: `Can't change this leftover — ${rupees(payable.settledPaise)} of what you owed ${payable.personName} has already been paid back. Clear that repayment first.`,
    };
  }
  return OK;
}
