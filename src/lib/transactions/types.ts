import type { SplitSettlementStatus } from "@/lib/splits/settlement-status";

/**
 * Shapes returned by the transaction read actions. Client-safe (types only):
 * used by NoteDialog / LinkedTransactionLink and the server handlers.
 */
export interface NoteCandidate {
  id: string;
  txnDate: string;
  amountPaise: number;
  drCr: "debit" | "credit";
  rawDescription: string;
  currentNote: string | null;
}

export type LinkedTransactionPreview = {
  id: string;
  txnDate: string;
  amountPaise: number;
  drCr: "debit" | "credit";
  channel: string;
  counterpartyLabel: string;
  parsedPurpose: string | null;
  note: string | null;
  split: {
    yourSharePaise: number;
    totalPaise: number;
    status: SplitSettlementStatus;
    expectedReimbursePaise: number;
    settledReimbursePaise: number;
    outstandingReimbursePaise: number;
    participants: Array<{
      personName: string;
      expectedAmountPaise: number;
      settledAmountPaise: number;
      outstandingAmountPaise: number;
    }>;
  } | null;
};
