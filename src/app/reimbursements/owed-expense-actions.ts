"use server";
import { defineAction } from "@/lib/action/define-action";
import { createOwedExpenseSpec, updateOwedExpenseSpec, deleteOwedExpenseSpec } from "./owed-expense-handlers";
export const createOwedExpense = defineAction("createOwedExpense", createOwedExpenseSpec);
export const updateOwedExpense = defineAction("updateOwedExpense", updateOwedExpenseSpec);
export const deleteOwedExpense = defineAction("deleteOwedExpense", deleteOwedExpenseSpec);
