"use server";

import { defineAction } from "@/lib/action/define-action";
import {
  createOwedExpenseSpec,
  deleteOwedExpenseSpec,
  updateOwedExpenseSpec,
} from "./owed-expense-handlers";

// Logic lives in ./owed-expense-handlers.ts.

export const createOwedExpense = defineAction("createOwedExpense", createOwedExpenseSpec);
export const updateOwedExpense = defineAction("updateOwedExpense", updateOwedExpenseSpec);
export const deleteOwedExpense = defineAction("deleteOwedExpense", deleteOwedExpenseSpec);
