/**
 * Shapes shared by the assistant's server action and its client panel.
 * Everything here is plain data (serializable across the action boundary).
 */

export interface CategoryLite {
  id: string;
  name: string;
  kind: string;
}

/** A transaction as the chat card shows it — always read fresh from the DB. */
export interface TxnCardData {
  id: string;
  txnDate: string;
  amountPaise: number;
  drCr: "debit" | "credit";
  channel: string;
  label: string;
  purpose: string | null;
  note: string | null;
  categoryId: string | null;
  needsReview: boolean;
  split: {
    participants: number;
    settled: number;
    pendingPaise: number;
    yourSharePaise: number;
  } | null;
  netEventId: string | null;
  href: string;
}

export interface NetLine {
  /** split_participant id (receivable) or owed_expense id (payable). */
  id: string;
  person: string;
  date: string;
  desc: string;
  outstandingPaise: number;
  /** Rupees as typed in the card, e.g. "380.00" or "". */
  val: string;
}

export type OpDraft =
  | {
      op: "split";
      txnId: string;
      totalPaise: number;
      /** Rupees, "" = the remainder. */
      yourShare: string;
      parts: Array<{ name: string; amt: string; known: boolean }>;
    }
  | { op: "note"; txnId: string; currentNote: string | null; note: string }
  | { op: "cat"; txnId: string; currentCategoryId: string | null; categoryId: string }
  | {
      /** Give every other uncategorized payment from this payee the same category. */
      op: "cat_all";
      txnId: string;
      categoryId: string;
      payee: string;
      /** How many rows it will change, as counted when the card was made. */
      count: number;
    }
  | {
      op: "net";
      txnId: string;
      inflowPaise: number;
      eventDate: string;
      person: string;
      recv: NetLine[];
      pay: NetLine[];
      note: string;
    };

export type OpStatus = "pending" | "applying" | "applied" | "undoing" | "discarded" | "undone";

export type UndoInfo =
  | { kind: "note"; prevNote: string | null; appliedNote: string }
  | { kind: "cat"; prevCategoryId: string | null; appliedCategoryId: string }
  | { kind: "cat_all"; ids: string[]; categoryId: string }
  | { kind: "split" }
  | { kind: "net"; netEventId: string };

export type ChatMessage =
  | { kind: "user"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | {
      kind: "ai";
      id: string;
      text: string;
      /** Tool calls and their results — what came from Money data. */
      trace?: string[];
      /** Why AI wasn't used for this reply, when it wasn't. */
      notice?: string;
      /** Transaction to jump to with "Show in table →". */
      link?: string;
      /** Resend the last request (after a failed turn). */
      retry?: boolean;
      /** Small status line, e.g. the ChatGPT limit. */
      meta?: string;
      /** Who wrote the reply text: the model, or built-in rules. */
      source?: "ai" | "rules";
      /** A follow-up the user can take; it opens a pending card, never writes. */
      action?: { kind: "cat_all"; txnId: string; label: string; state?: "running" | "done" };
    }
  | {
      kind: "txn";
      id: string;
      txnId: string;
      /** Why this row matched the search — computed from the row, not the model. */
      reasons?: string[];
    }
  | {
      kind: "pick";
      id: string;
      txnIds: string[];
      /** Matches in total; only the best few are listed. */
      total?: number;
      reasons?: Record<string, string[]>;
      picked?: string;
      /** "act": the user asked for a change — picking resumes their request. */
      then: "show" | "act";
      /** The request to resume after a pick when then = "act". */
      request?: string;
    }
  | {
      kind: "op";
      id: string;
      draft: OpDraft;
      status: OpStatus;
      error?: string;
      undo?: UndoInfo;
    };

/** What a turn sends back; ids are assigned by the client. */
export type TurnMessage =
  | Omit<Extract<ChatMessage, { kind: "ai" }>, "id">
  | Omit<Extract<ChatMessage, { kind: "txn" }>, "id">
  | Omit<Extract<ChatMessage, { kind: "pick" }>, "id">
  | { kind: "op"; draft: OpDraft };

export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}
