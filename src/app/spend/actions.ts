"use server";

import { defineAction } from "@/lib/action/define-action";
import { getCategoryTransactionsSpec } from "./spend-handlers";

// Logic lives in ./spend-handlers.ts.

export const getCategoryTransactions = defineAction("getCategoryTransactions", getCategoryTransactionsSpec);
