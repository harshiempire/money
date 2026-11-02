/** Synthetic, database-free fixtures shared by MCP read tests. */
import type { McpTransaction } from "./view";
import type { McpReadModel } from "./read-model";
import { buildReadView } from "./model-view";
import { deriveMcpRefKey, deriveMcpRevKey } from "./refs";
export const readActor = { userId: "fixture-owner", accountId: "fixture-account" };
export const readKey = deriveMcpRefKey("synthetic-test-secret");
export const readRevKey = deriveMcpRevKey("synthetic-test-secret");
export function fixtureTxn(id: string, overrides: Partial<McpTransaction> = {}): McpTransaction {
  return { id, txnDate: "2026-07-31", amountPaise: 56700, drCr: "debit", channel: "upi", displayName: "Rooster X", counterpartyKey: "rooster@bank", counterpartyKind: "upi_handle", parsedPurpose: "Petr", label: "bank label", rawDescription: "UPI 12345678 rooster@bank", note: null, category: null, categoryId: null, needsReview: false, isTransfer: false, ...overrides };
}
export function readFixture(): McpReadModel {
  return {
    transactions: [
      fixtureTxn("private-bill"),
      fixtureTxn("private-old-bill", { txnDate: "2026-04-20", amountPaise: 1200 }),
      ...["one", "two", "unlinked", "net", "owed-back"].map((id, i) => fixtureTxn(`private-in-${id}`, { txnDate: `2026-08-0${i + 1}`, amountPaise: 10000, drCr: "credit", counterpartyKey: "kiranrao@o", displayName: "Kiran@bank 123456", rawDescription: "UPI 87654321 kiranrao@o" })),
      fixtureTxn("private-unrelated", { txnDate: "2026-08-06", drCr: "credit", counterpartyKey: "someone@bank", displayName: "Other", rawDescription: "UPI someone@bank" }),
    ],
    people: [{ name: "Kiran" }, { name: "Ravi Teja" }, { name: "No Activity" }],
    payees: [
      { key: "kiranrao@o", kind: "upi_handle", displayName: "Kiran@bank 123456", defaultCategory: null, isSelf: false, isFamily: false },
      { key: "rooster@bank", kind: "upi_handle", displayName: "Rooster X", defaultCategory: "Food", isSelf: false, isFamily: false },
      { key: "someone@bank", kind: "upi_handle", displayName: "Other", defaultCategory: null, isSelf: false, isFamily: true },
    ],
    splits: [
      { id: "private-split", transactionId: "private-bill", totalPaise: 56700, yourSharePaise: 29300 },
      { id: "private-old-split", transactionId: "private-old-bill", totalPaise: 1200, yourSharePaise: 600 },
    ],
    shares: [
      { id: "private-share", splitId: "private-split", personName: " kiran ", expectedAmountPaise: 27400 },
      { id: "private-old-share", splitId: "private-old-split", personName: "KIRAN", expectedAmountPaise: 600 },
    ],
    owed: [
      { id: "private-owed", personName: " Kiran", incurredDate: "2026-05-01", description: "Movie tickets 123456@bank", amountPaise: 30000, sourceInflowTransactionId: null },
      { id: "private-residual", personName: "kiran", incurredDate: "2026-08-05", description: "Overpayment", amountPaise: 10000, sourceInflowTransactionId: "private-in-owed-back" },
      { id: "private-historical", personName: "Only Historical", incurredDate: "2026-03-01", description: "Old expense", amountPaise: 100, sourceInflowTransactionId: null },
    ],
    settlements: [
      { id: "private-stl-one", splitParticipantId: "private-share", owedExpenseId: null, inflowTransactionId: "private-in-one", netEventId: null, amountPaise: 5000, method: "bank", createdDate: "2026-09-01" },
      { id: "private-stl-two", splitParticipantId: "private-old-share", owedExpenseId: null, inflowTransactionId: "private-in-one", netEventId: null, amountPaise: 100, method: "bank", createdDate: "2026-09-01" },
      { id: "private-stl-owed", splitParticipantId: null, owedExpenseId: "private-owed", inflowTransactionId: "private-in-two", netEventId: null, amountPaise: 1000, method: "bank", createdDate: "2026-09-01" },
      { id: "private-stl-cash", splitParticipantId: "private-old-share", owedExpenseId: null, inflowTransactionId: null, netEventId: null, amountPaise: 200, method: "cash", createdDate: "2026-06-01" },
      { id: "private-stl-forgiven", splitParticipantId: "private-old-share", owedExpenseId: null, inflowTransactionId: null, netEventId: null, amountPaise: 100, method: "writeoff", createdDate: "2026-06-02" },
      { id: "private-stl-net-bank", splitParticipantId: "private-share", owedExpenseId: null, inflowTransactionId: "private-in-net", netEventId: "private-event", amountPaise: 1000, method: "bank", createdDate: "2026-09-01" },
      { id: "private-stl-net-share", splitParticipantId: "private-share", owedExpenseId: null, inflowTransactionId: null, netEventId: "private-event", amountPaise: 2000, method: "offset", createdDate: "2026-09-01" },
      { id: "private-stl-net-owed", splitParticipantId: null, owedExpenseId: "private-owed", inflowTransactionId: null, netEventId: "private-event", amountPaise: 2000, method: "offset", createdDate: "2026-09-01" },
    ],
    netEvents: [{ id: "private-event", eventDate: "2026-08-04", inflowTransactionId: "private-in-net", outflowTransactionId: null }],
  };
}
export const fixtureView = (model = readFixture()) => buildReadView(model, readActor, readKey, readRevKey);
