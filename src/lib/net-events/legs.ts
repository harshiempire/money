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
      { owedExpenseId: string; newPayable?: never } | { owedExpenseId?: never; newPayable: NewPayableSpec }
    ));

/** Copy only declared fields; preserve both payable fields for core validation. */
export function pickNetEventLeg(leg: NetEventLeg): NetEventLeg {
  if (leg.kind === "receivable") return {
    kind: leg.kind,
    splitParticipantId: leg.splitParticipantId,
    amountPaise: leg.amountPaise,
    method: leg.method,
  };
  return {
    kind: leg.kind,
    amountPaise: leg.amountPaise,
    method: leg.method,
    ...(leg.owedExpenseId !== undefined ? { owedExpenseId: leg.owedExpenseId } : {}),
    ...(leg.newPayable !== undefined ? { newPayable: {
      personName: leg.newPayable.personName,
      incurredDate: leg.newPayable.incurredDate,
      amountPaise: leg.newPayable.amountPaise,
      description: leg.newPayable.description,
      ...(leg.newPayable.categoryId !== undefined ? { categoryId: leg.newPayable.categoryId } : {}),
      ...(leg.newPayable.note !== undefined ? { note: leg.newPayable.note } : {}),
    } } : {}),
  } as NetEventLeg;
}
