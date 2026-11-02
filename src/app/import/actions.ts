"use server";

import { defineAction } from "@/lib/action/define-action";
import { uploadStatementSpec } from "./import-handlers";

// Logic lives in ./import-handlers.ts.

export const uploadStatement = defineAction("uploadStatement", uploadStatementSpec);
