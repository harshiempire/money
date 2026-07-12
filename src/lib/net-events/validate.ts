import type { NetEventLeg } from "@/app/transactions/net-event-actions";

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

/**
 * Bank invariant: Σ receivable − Σ payable = inflow − outflow (exact paise).
 *
 * residual = (R − P) − expectedNet
 *  residual > 0 → net too high → reduce a receivable or increase a payable
 *  residual < 0 → net too low  → increase a receivable or reduce a payable
 *
 * Prefers adjusting the largest current allocation that can absorb residual
 * without exceeding outstanding caps or going negative.
 */
export function balanceAllocationsToExpectedNet(
  receivableAllocs: Record<string, number>,
  payableAllocs: Record<string, number>,
  receivableCaps: Record<string, number>,
  payableCaps: Record<string, number>,
  expectedNet: number,
): {
  receivableAllocs: Record<string, number>;
  payableAllocs: Record<string, number>;
  adjusted: { side: "receivable" | "payable"; id: string; byPaise: number };
} | null {
  const sum = (m: Record<string, number>) =>
    Object.values(m).reduce((s, v) => s + v, 0);

  const nextR = { ...receivableAllocs };
  const nextP = { ...payableAllocs };
  let residual = sum(nextR) - sum(nextP) - expectedNet;
  if (residual === 0) {
    return null;
  }

  const sortedIds = (m: Record<string, number>) =>
    Object.keys(m)
      .filter((id) => m[id] > 0)
      .sort((a, b) => m[b] - m[a]);

  if (residual > 0) {
    // Prefer shaving the largest receivable
    for (const id of sortedIds(nextR)) {
      const room = nextR[id]; // can reduce by up to full alloc
      if (room >= residual) {
        nextR[id] -= residual;
        if (nextR[id] === 0) delete nextR[id];
        return {
          receivableAllocs: nextR,
          payableAllocs: nextP,
          adjusted: { side: "receivable", id, byPaise: -residual },
        };
      }
    }
    // Else grow a payable toward its cap
    for (const id of Object.keys(payableCaps).sort(
      (a, b) => (nextP[b] ?? 0) - (nextP[a] ?? 0),
    )) {
      const current = nextP[id] ?? 0;
      const room = payableCaps[id] - current;
      if (room >= residual) {
        nextP[id] = current + residual;
        return {
          receivableAllocs: nextR,
          payableAllocs: nextP,
          adjusted: { side: "payable", id, byPaise: residual },
        };
      }
    }
    return null;
  }

  // residual < 0
  const need = -residual;
  for (const id of Object.keys(receivableCaps).sort(
    (a, b) => (nextR[b] ?? 0) - (nextR[a] ?? 0),
  )) {
    const current = nextR[id] ?? 0;
    const room = receivableCaps[id] - current;
    if (room >= need) {
      nextR[id] = current + need;
      return {
        receivableAllocs: nextR,
        payableAllocs: nextP,
        adjusted: { side: "receivable", id, byPaise: need },
      };
    }
  }
  for (const id of sortedIds(nextP)) {
    if (nextP[id] >= need) {
      nextP[id] -= need;
      if (nextP[id] === 0) delete nextP[id];
      return {
        receivableAllocs: nextR,
        payableAllocs: nextP,
        adjusted: { side: "payable", id, byPaise: -need },
      };
    }
  }
  return null;
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
