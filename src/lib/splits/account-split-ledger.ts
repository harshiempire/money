import "server-only";

import { cache } from "react";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { counterpartyLabel, formatDate } from "@/lib/format";
import { settledAmountByParticipantIds } from "@/lib/splits/outstanding";
import type { ParticipantOption } from "@/app/transactions/SettleDialog";
import type { ReceivableOption } from "@/lib/net-events/load-net-settle-data";

export interface AccountSplitLedger {
  splits: Array<{
    id: string;
    transactionId: string;
    txnDate: string;
    rawDescription: string;
  }>;
  participants: (typeof schema.splitParticipants.$inferSelect)[];
  settledByParticipant: Map<string, number>;
}

async function loadAccountSplitLedgerImpl(
  accountId: string,
): Promise<AccountSplitLedger> {
  const splits = await db
    .select({
      id: schema.splits.id,
      transactionId: schema.splits.transactionId,
      txnDate: schema.transactions.txnDate,
      rawDescription: schema.transactions.rawDescription,
    })
    .from(schema.splits)
    .innerJoin(
      schema.transactions,
      eq(schema.splits.transactionId, schema.transactions.id),
    )
    .where(eq(schema.transactions.accountId, accountId));

  if (splits.length === 0) {
    return { splits: [], participants: [], settledByParticipant: new Map() };
  }

  const participants = await db
    .select()
    .from(schema.splitParticipants)
    .where(
      inArray(
        schema.splitParticipants.splitId,
        splits.map((s) => s.id),
      ),
    );

  const settledByParticipant = await settledAmountByParticipantIds(
    participants.map((p) => p.id),
  );

  return { splits, participants, settledByParticipant };
}

export function buildParticipantOptions(
  ledger: AccountSplitLedger,
): ParticipantOption[] {
  const splitMetaById = new Map(ledger.splits.map((s) => [s.id, s]));
  return ledger.participants.map((p) => {
    const meta = splitMetaById.get(p.splitId)!;
    return {
      id: p.id,
      personName: p.personName,
      expectedAmountPaise: Number(p.expectedAmountPaise),
      splitTransactionDate: formatDate(meta.txnDate),
      splitTransactionDescription:
        counterpartyLabel(meta.rawDescription) ?? meta.rawDescription,
      alreadySettledPaise: ledger.settledByParticipant.get(p.id) ?? 0,
    };
  });
}

export function buildOpenReceivablesFromLedger(
  ledger: AccountSplitLedger,
): ReceivableOption[] {
  const splitMeta = new Map(ledger.splits.map((s) => [s.id, s]));
  return ledger.participants
    .map((p) => {
      const meta = splitMeta.get(p.splitId)!;
      const expected = Number(p.expectedAmountPaise);
      const paid = ledger.settledByParticipant.get(p.id) ?? 0;
      const outstandingPaise = Math.max(0, expected - paid);
      return {
        id: p.id,
        personName: p.personName,
        personId: p.personId,
        expectedAmountPaise: expected,
        outstandingPaise,
        splitTransactionDate: meta.txnDate,
        splitTransactionDescription: meta.rawDescription,
      };
    })
    .filter((r) => r.outstandingPaise > 0);
}

/** Per-request cached account split graph (dedupes transactions + reimbursements). */
export const getAccountSplitLedger = cache(loadAccountSplitLedgerImpl);
