"use server";

import { defineAction } from "@/lib/action/define-action";
import {
  deleteCashSettlementSpec,
  recordCashSettlementSpec,
  undoWriteOffSpec,
  writeOffParticipantShareSpec,
} from "./reimbursement-handlers";

// Logic lives in ./reimbursement-handlers.ts.

export const recordCashSettlement = defineAction("recordCashSettlement", recordCashSettlementSpec);
export const deleteCashSettlement = defineAction("deleteCashSettlement", deleteCashSettlementSpec);
export const writeOffParticipantShare = defineAction("writeOffParticipantShare", writeOffParticipantShareSpec);
export const undoWriteOff = defineAction("undoWriteOff", undoWriteOffSpec);
