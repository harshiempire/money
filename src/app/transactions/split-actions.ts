"use server";
import { defineAction } from "@/lib/action/define-action";
import { createSplitSpec, deleteSplitSpec, recordSettlementSpec, clearSettlementSpec } from "./split-handlers";
export type { ParticipantInput } from "@/lib/splits/types";
export const createSplit = defineAction("createSplit", createSplitSpec);
export const deleteSplit = defineAction("deleteSplit", deleteSplitSpec);
export const recordSettlement = defineAction("recordSettlement", recordSettlementSpec);
export const clearSettlement = defineAction("clearSettlement", clearSettlementSpec);
