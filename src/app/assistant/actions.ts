"use server";

import { defineAction } from "@/lib/action/define-action";
import {
  getAssistantBootstrapSpec,
  assistantTurnSpec,
  loadAssistantTxnsSpec,
  prepareAssistantOpSpec,
  prepareApplyToAllSpec,
} from "./assistant-handlers";
export type { AiState, AssistantBootstrap, TurnData, TurnResult } from "./assistant-handlers";

export const getAssistantBootstrap = defineAction("getAssistantBootstrap", getAssistantBootstrapSpec);
export const assistantTurn = defineAction("assistantTurn", assistantTurnSpec);
export const loadAssistantTxns = defineAction("loadAssistantTxns", loadAssistantTxnsSpec);
export const prepareAssistantOp = defineAction("prepareAssistantOp", prepareAssistantOpSpec);
export const prepareApplyToAll = defineAction("prepareApplyToAll", prepareApplyToAllSpec);
