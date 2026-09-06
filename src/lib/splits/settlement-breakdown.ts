import { formatPaise } from "@/lib/format";
import type { SplitSettlementStatus } from "./settlement-status";

export type SettlementMethod = "bank" | "cash" | "offset" | "writeoff";

export interface SettlementBreakdown {
  bankPaise: number;
  cashPaise: number;
  offsetPaise: number;
  writeoffPaise: number;
}

export interface ParticipantSettlementSummary {
  totalPaise: number;
  breakdown: SettlementBreakdown;
}

export const emptySettlementBreakdown = (): SettlementBreakdown => ({
  bankPaise: 0,
  cashPaise: 0,
  offsetPaise: 0,
  writeoffPaise: 0,
});

export function summarizeParticipantSettlements(
  rows: Array<{
    splitParticipantId: string | null;
    amountPaise: number | bigint;
    method: SettlementMethod;
  }>,
): Map<string, ParticipantSettlementSummary> {
  const byParticipant = new Map<string, ParticipantSettlementSummary>();

  for (const row of rows) {
    if (!row.splitParticipantId) continue;
    const amountPaise = Number(row.amountPaise);
    const current = byParticipant.get(row.splitParticipantId) ?? {
      totalPaise: 0,
      breakdown: emptySettlementBreakdown(),
    };
    current.totalPaise += amountPaise;
    switch (row.method) {
      case "bank":
        current.breakdown.bankPaise += amountPaise;
        break;
      case "cash":
        current.breakdown.cashPaise += amountPaise;
        break;
      case "offset":
        current.breakdown.offsetPaise += amountPaise;
        break;
      case "writeoff":
        current.breakdown.writeoffPaise += amountPaise;
        break;
    }
    byParticipant.set(row.splitParticipantId, current);
  }

  return byParticipant;
}

export function formatSettlementResolution(input: {
  status: SplitSettlementStatus;
  settledParticipantCount: number;
  totalParticipantCount: number;
  outstandingReimbursePaise: number;
  breakdown: SettlementBreakdown;
}): string {
  const receivedPaise =
    input.breakdown.bankPaise + input.breakdown.cashPaise;
  const resolutionParts: string[] = [];
  if (receivedPaise > 0) {
    resolutionParts.push(`${formatPaise(receivedPaise)} received`);
  }
  if (input.breakdown.offsetPaise > 0) {
    resolutionParts.push(`${formatPaise(input.breakdown.offsetPaise)} offset`);
  }
  if (input.breakdown.writeoffPaise > 0) {
    resolutionParts.push(
      `${formatPaise(input.breakdown.writeoffPaise)} forgiven`,
    );
  }

  if (input.status === "settled") {
    return resolutionParts.length > 0
      ? `Resolved · ${resolutionParts.join(" · ")}`
      : "Resolved";
  }

  const pending = `${input.settledParticipantCount}/${input.totalParticipantCount} settled · ${formatPaise(input.outstandingReimbursePaise)} pending`;
  return resolutionParts.length > 0
    ? `${pending} · ${resolutionParts.join(" · ")}`
    : pending;
}
