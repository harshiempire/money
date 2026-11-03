"use server";
import { defineAction } from "@/lib/action/define-action";
import { getCategoryTransactionsSpec } from "./spend-handlers";
export const getCategoryTransactions = defineAction("getCategoryTransactions", getCategoryTransactionsSpec);
