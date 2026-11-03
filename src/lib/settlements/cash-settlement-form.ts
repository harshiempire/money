// Client-safe form logic. Keep the dialog's existing rounded-paise conversion.
import { paiseToRupeesStr, rupeesToPaise } from "@/lib/splits/split-form";

export interface CashSettlementFormValues {
  amount: string;
  note: string;
}

export function initialCashSettlementFormValues(
  outstandingPaise: number,
): CashSettlementFormValues {
  return { amount: paiseToRupeesStr(outstandingPaise), note: "" };
}

/** Invalid amounts have always disabled Save without showing an error. */
export function validateCashSettlementForm(
  values: CashSettlementFormValues,
): true | undefined {
  const parsedPaise = rupeesToPaise(values.amount);
  return Number.isFinite(parsedPaise) && parsedPaise > 0 ? undefined : true;
}

export function buildCashSettlementPayload(
  values: CashSettlementFormValues,
  splitParticipantId: string,
) {
  return {
    splitParticipantId,
    amountPaise: rupeesToPaise(values.amount),
    note: values.note,
  };
}
