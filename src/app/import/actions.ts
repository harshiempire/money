"use server";
import { defineAction } from "@/lib/action/define-action";
import { uploadStatementSpec } from "./import-handlers";
export const uploadStatement = defineAction("uploadStatement", uploadStatementSpec);
