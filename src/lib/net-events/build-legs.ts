import type { NetEventLeg, NewPayableSpec } from "@/app/transactions/net-event-actions";

/**
 * Turns per-line allocations (exact paise) into net-event legs. Receivables
 * spend the bank inflow first ("bank" legs, in the order given) and whatever
 * is left of each is an "offset" against a payable; payables are always
 * offsets. Shared by NetSettleDialog and the assistant's net-settle card so
 * both save the same shape.
 */
export function buildNetLegs(input: {
  receivables: Array<{ id: string; paise: number }>;
  payables: Array<{ id: string; paise: number }>;
  newPayables?: Array<{ spec: NewPayableSpec; paise: number }>;
  inflowTransactionId: string | undefined;
  inflowAmountPaise: number;
}): NetEventLeg[] {
  const legs: NetEventLeg[] = [];
  let bankRemaining = input.inflowAmountPaise;

  for (const r of input.receivables) {
    let amountPaise = r.paise;
    if (!(amountPaise > 0)) continue;
    if (bankRemaining > 0 && input.inflowTransactionId) {
      const bankPart = Math.min(amountPaise, bankRemaining);
      legs.push({ kind: "receivable", splitParticipantId: r.id, amountPaise: bankPart, method: "bank" });
      bankRemaining -= bankPart;
      amountPaise -= bankPart;
    }
    if (amountPaise > 0) {
      legs.push({ kind: "receivable", splitParticipantId: r.id, amountPaise, method: "offset" });
    }
  }

  for (const p of input.payables) {
    if (!(p.paise > 0)) continue;
    legs.push({ kind: "payable", owedExpenseId: p.id, amountPaise: p.paise, method: "offset" });
  }

  for (const p of input.newPayables ?? []) {
    if (!(p.paise > 0)) continue;
    legs.push({ kind: "payable", newPayable: p.spec, amountPaise: p.paise, method: "offset" });
  }

  return legs;
}
