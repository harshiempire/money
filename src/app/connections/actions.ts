"use server";

import { defineAction } from "@/lib/action/define-action";
import {
  listMcpTokensSpec,
  createMcpTokenSpec,
  revokeMcpTokenSpec,
  listLedgerChangesSpec,
  undoLedgerChangeSpec,
} from "./connection-handlers";

export const listMcpTokens = defineAction("listMcpTokens", listMcpTokensSpec);
export const createMcpToken = defineAction("createMcpToken", createMcpTokenSpec);
export const revokeMcpToken = defineAction("revokeMcpToken", revokeMcpTokenSpec);
export const listLedgerChanges = defineAction("listLedgerChanges", listLedgerChangesSpec);
export const undoLedgerChange = defineAction("undoLedgerChange", undoLedgerChangeSpec);
