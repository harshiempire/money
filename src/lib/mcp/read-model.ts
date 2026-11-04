import type { PersonBalance } from "@/lib/ledger/rules/balances";
import type { McpTransaction } from "./view";

/** Internal, actor-scoped snapshot. Only explicit DTO builders may cross the MCP boundary. */
export interface McpReadModel {
  balances?: Array<PersonBalance & { linkedPayees: Array<{key:string;displayName:string | null;kind:string}> }>;
  transactions: McpTransaction[];
  /** Credits linked to any allocation/event/source expense, even when its target is outside this account, or fully acknowledged as kept/written off. */
  linkedInflows?: string[];
  people: Array<{ id?: string; name: string }>;
  payees: Array<{ personId?: string | null; person?: string | null; key: string; kind: string; displayName: string | null; defaultCategory: string | null; isSelf: boolean; isFamily: boolean }>;
  splits: Array<{ id: string; transactionId: string; createdAt?: string; totalPaise: number; yourSharePaise: number }>;
  shares: Array<{ id: string; splitId: string; personId?: string | null; personName: string; expectedAmountPaise: number }>;
  owed: Array<{ id: string; personId?: string | null; personName: string; incurredDate: string; description: string; amountPaise: number; sourceInflowTransactionId: string | null }>;
  settlements: Array<{ id: string; splitParticipantId: string | null; owedExpenseId: string | null; inflowTransactionId: string | null; netEventId: string | null; amountPaise: number; method: "bank" | "cash" | "offset" | "writeoff"; createdDate: string }>;
  netEvents: Array<{ id: string; eventDate: string; inflowTransactionId: string | null; outflowTransactionId: string | null }>;
}
