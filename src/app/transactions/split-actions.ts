"use server";

import { defineAction } from "@/lib/action/define-action";
import {
  clearSettlementSpec,
  createSplitSpec,
  deleteSplitSpec,
  recordSettlementSpec,
} from "./split-handlers";

// Logic lives in ./split-handlers.ts; this file only exposes it as server
// actions (auth, input decoding, ActionResult, revalidation).

export const createSplit = defineAction("createSplit", createSplitSpec);
export const deleteSplit = defineAction("deleteSplit", deleteSplitSpec);
export const recordSettlement = defineAction("recordSettlement", recordSettlementSpec);
export const clearSettlement = defineAction("clearSettlement", clearSettlementSpec);
