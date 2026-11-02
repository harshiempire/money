/**
 * Leg shapes for a Net Settle event. Client-safe (types only) — shared by
 * NetSettleDialog, the validators, and the server handlers.
 */
export type NewPayableSpec = {
  personName: string;
  incurredDate: string;
  amountPaise: number;
  description: string;
  categoryId?: string | null;
  note?: string | null;
};

export type NetEventLeg =
  | {
      kind: "receivable";
      splitParticipantId: string;
      amountPaise: number;
      method: "bank" | "offset";
    }
  | ({
      kind: "payable";
      amountPaise: number;
      method: "offset";
    } & (
      | { owedExpenseId: string; newPayable?: never }
      | { owedExpenseId?: never; newPayable: NewPayableSpec }
    ));

/** The two fields the bank-invariant sums need. */
export type LegAmount = Pick<NetEventLeg, "kind" | "amountPaise">;
