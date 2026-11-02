import type { McpTransaction } from "./view";

/** Internal, actor-scoped snapshot. Only explicit DTO builders may cross the MCP boundary. */
export interface McpReadModel {
  transactions: McpTransaction[];
  /** Credits linked to any allocation/event/source expense, even when its target is outside this account. */
  linkedInflows?: string[];
  people: Array<{ name: string }>;
  payees: Array<{ person?: string | null; key: string; kind: string; displayName: string | null; defaultCategory: string | null; isSelf: boolean; isFamily: boolean }>;
  splits: Array<{ id: string; transactionId: string; totalPaise: number; yourSharePaise: number }>;
  shares: Array<{ id: string; splitId: string; personName: string; expectedAmountPaise: number }>;
  owed: Array<{ id: string; personName: string; incurredDate: string; description: string; amountPaise: number; sourceInflowTransactionId: string | null }>;
  settlements: Array<{ id: string; splitParticipantId: string | null; owedExpenseId: string | null; inflowTransactionId: string | null; netEventId: string | null; amountPaise: number; method: "bank" | "cash" | "offset" | "writeoff"; createdDate: string }>;
  netEvents: Array<{ id: string; eventDate: string; inflowTransactionId: string | null; outflowTransactionId: string | null }>;
}
