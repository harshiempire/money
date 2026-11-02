"use server";

import { defineAction } from "@/lib/action/define-action";
import {
  applyCategoryToCounterpartySpec,
  applyNoteToTransactionsSpec,
  autoDetectTransfersSpec,
  setTransactionCategorySpec,
  setTransactionNeedsReviewSpec,
  setTransactionNoteSpec,
  setTransactionTransferSpec,
} from "./transaction-handlers";
import {
  getLinkedTransactionPreviewSpec,
  getNoteCandidatesSpec,
} from "./transaction-read-handlers";

// Logic lives in ./transaction-handlers.ts (edits) and
// ./transaction-read-handlers.ts (reads). Return types: @/lib/transactions/types.

export const setTransactionCategory = defineAction("setTransactionCategory", setTransactionCategorySpec);
export const applyCategoryToCounterparty = defineAction("applyCategoryToCounterparty", applyCategoryToCounterpartySpec);
export const setTransactionTransfer = defineAction("setTransactionTransfer", setTransactionTransferSpec);
export const setTransactionNeedsReview = defineAction("setTransactionNeedsReview", setTransactionNeedsReviewSpec);
export const setTransactionNote = defineAction("setTransactionNote", setTransactionNoteSpec);
export const applyNoteToTransactions = defineAction("applyNoteToTransactions", applyNoteToTransactionsSpec);
export const autoDetectTransfers = defineAction("autoDetectTransfers", autoDetectTransfersSpec);

export const getNoteCandidates = defineAction("getNoteCandidates", getNoteCandidatesSpec);
export const getLinkedTransactionPreview = defineAction("getLinkedTransactionPreview", getLinkedTransactionPreviewSpec);
