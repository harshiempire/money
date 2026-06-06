import type { NetEventLeg } from "@/app/(app)/transactions/net-event-actions";

export function sumReceivableLegs(legs: NetEventLeg[]): number {
  return legs
    .filter((l) => l.kind === "receivable")
    .reduce((s, l) => s + l.amountPaise, 0);
}

export function sumPayableLegs(legs: NetEventLeg[]): number {
  return legs
    .filter((l) => l.kind === "payable")
    .reduce((s, l) => s + l.amountPaise, 0);
}

export function validateNetEventInvariant(
  legs: NetEventLeg[],
  inflowAmountPaise: number,
  outflowAmountPaise: number,
): { ok: true } | { ok: false; message: string } {
  const receivableTotal = sumReceivableLegs(legs);
  const payableTotal = sumPayableLegs(legs);
  const netTotal = receivableTotal - payableTotal;
  const expectedNet = inflowAmountPaise - outflowAmountPaise;

  if (netTotal !== expectedNet) {
    return {
      ok: false,
      message: `Net ${netTotal / 100} does not match bank delta ${expectedNet / 100}`,
    };
  }
  return { ok: true };
}

/** 16-Apr GPay scenario: Starbucks ₹444 receivable, biker ₹295 payable, ₹149 inflow */
export function buildApr16ScenarioLegs(
  starbucksParticipantId: string,
  bikerOwedExpenseId: string,
): NetEventLeg[] {
  return [
    {
      kind: "receivable",
      splitParticipantId: starbucksParticipantId,
      amountPaise: 14900,
      method: "bank",
    },
    {
      kind: "receivable",
      splitParticipantId: starbucksParticipantId,
      amountPaise: 29500,
      method: "offset",
    },
    {
      kind: "payable",
      owedExpenseId: bikerOwedExpenseId,
      amountPaise: 29500,
      method: "offset",
    },
  ];
}

/** 8-May GPay scenario: vyapar ₹798 receivable, milk ₹520.50 payable, ₹277.50 inflow */
export function buildMay8ScenarioLegs(
  vyaparParticipantId: string,
  milkOwedExpenseId: string,
): NetEventLeg[] {
  return [
    {
      kind: "receivable",
      splitParticipantId: vyaparParticipantId,
      amountPaise: 27750,
      method: "bank",
    },
    {
      kind: "receivable",
      splitParticipantId: vyaparParticipantId,
      amountPaise: 52050,
      method: "offset",
    },
    {
      kind: "payable",
      owedExpenseId: milkOwedExpenseId,
      amountPaise: 52050,
      method: "offset",
    },
  ];
}
