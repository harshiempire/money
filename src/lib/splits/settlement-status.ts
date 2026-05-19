export type SplitSettlementStatus = "none" | "open" | "partial" | "settled";

export interface SplitSettlementSummary {
  status: SplitSettlementStatus;
  expectedReimbursePaise: number;
  settledReimbursePaise: number;
  outstandingReimbursePaise: number;
  settledParticipantCount: number;
  totalParticipantCount: number;
}

export function summarizeSplitSettlement(
  participants: Array<{
    expectedAmountPaise: number;
    settledAmountPaise: number;
  }>,
): SplitSettlementSummary {
  const totalParticipantCount = participants.length;
  if (totalParticipantCount === 0) {
    return {
      status: "none",
      expectedReimbursePaise: 0,
      settledReimbursePaise: 0,
      outstandingReimbursePaise: 0,
      settledParticipantCount: 0,
      totalParticipantCount: 0,
    };
  }

  let expectedReimbursePaise = 0;
  let settledReimbursePaise = 0;
  let settledParticipantCount = 0;

  for (const p of participants) {
    expectedReimbursePaise += p.expectedAmountPaise;
    settledReimbursePaise += p.settledAmountPaise;
    if (p.settledAmountPaise >= p.expectedAmountPaise) {
      settledParticipantCount += 1;
    }
  }

  const outstandingReimbursePaise = Math.max(
    0,
    expectedReimbursePaise - settledReimbursePaise,
  );

  let status: SplitSettlementStatus;
  if (outstandingReimbursePaise === 0) {
    status = "settled";
  } else if (settledReimbursePaise === 0) {
    status = "open";
  } else {
    status = "partial";
  }

  return {
    status,
    expectedReimbursePaise,
    settledReimbursePaise,
    outstandingReimbursePaise,
    settledParticipantCount,
    totalParticipantCount,
  };
}
