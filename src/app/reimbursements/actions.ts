"use server";
import { defineAction } from "@/lib/action/define-action";
import { recordCashSettlementSpec, deleteCashSettlementSpec, writeOffParticipantShareSpec, undoWriteOffSpec } from "./settlement-handlers";
export const recordCashSettlement = defineAction("recordCashSettlement", recordCashSettlementSpec);
export const deleteCashSettlement = defineAction("deleteCashSettlement", deleteCashSettlementSpec);
export const writeOffParticipantShare = defineAction("writeOffParticipantShare", writeOffParticipantShareSpec);
export const undoWriteOff = defineAction("undoWriteOff", undoWriteOffSpec);
