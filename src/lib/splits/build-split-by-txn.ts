import { summarizeSplitSettlement } from "./settlement-status";
import type { ExistingSplit } from "@/app/transactions/SplitDialog";

type SplitRow = {
  id: string;
  transactionId: string;
  totalPaise: number | bigint;
  yourSharePaise: number | bigint;
  note: string | null;
};

type ParticipantRow = {
  id: string;
  splitId: string;
  personName: string;
  expectedAmountPaise: number | bigint;
};

export function buildSplitByTxn(
  splits: SplitRow[],
  participantsAll: ParticipantRow[],
  settledByParticipant: Map<string, number>,
): Map<string, ExistingSplit> {
  const splitByTxn = new Map<string, ExistingSplit>();

  for (const s of splits) {
    const participants = participantsAll
      .filter((p) => p.splitId === s.id)
      .map((p) => {
        const expectedAmountPaise = Number(p.expectedAmountPaise);
        const settledAmountPaise = settledByParticipant.get(p.id) ?? 0;
        return {
          id: p.id,
          personName: p.personName,
          expectedAmountPaise,
          settledAmountPaise,
          outstandingAmountPaise: Math.max(
            0,
            expectedAmountPaise - settledAmountPaise,
          ),
        };
      });

    const summary = summarizeSplitSettlement(participants);

    splitByTxn.set(s.transactionId, {
      totalPaise: Number(s.totalPaise),
      yourSharePaise: Number(s.yourSharePaise),
      note: s.note,
      participants,
      ...summary,
    });
  }

  return splitByTxn;
}
