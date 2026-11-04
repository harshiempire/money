import "server-only";
import { Effect } from "effect";
import { Actor } from "./services";
import { ledgerQuery, runRelationalChangeEffect } from "./relational-store";
import { outstandingPaise } from "./rules/balances";
import { cashAmountCheck } from "./rules/settlement-policy";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { LedgerError, type WriteContext } from "./context";
import { runRelationalChange } from "./relational-store";

export interface RecordCashSettlementInput { splitParticipantId: string; amountPaise: number; note: string | null }
export interface CashSettlementReceipt { appliedPaise: number; leftPaise: number }
export const recordCashSettlement = Effect.fn("recordCashSettlement")(function* (context: WriteContext, input: RecordCashSettlementInput) {
  const actor = yield* Actor;
  return yield* runRelationalChangeEffect({ ...context, actor }, "record_cash_settlement", (tx, helpers) => Effect.gen(function* () {
    yield* ledgerQuery(() => helpers.assertSplitParticipantOwned(actor.userId, input.splitParticipantId));
    const participant = helpers.before.participants.find(r => r.id === input.splitParticipantId)!;
    const outstanding = outstandingPaise(participant.expectedAmountPaise, helpers.before.settlements.filter(r => r.splitParticipantId === participant.id));
    if (outstanding === null) return yield* new LedgerError({ code: "invalid_amount", message: "Balance exceeds the exact integer paise range." });
    const check = cashAmountCheck(input.amountPaise, outstanding);
    if (!check.ok) return yield* new LedgerError(check);
    yield* ledgerQuery(() => tx.insert(schema.settlements).values({ splitParticipantId: participant.id, amountPaise: input.amountPaise, method: "cash", note: input.note?.trim().slice(0,200) || null }));
    const value: CashSettlementReceipt = { appliedPaise: input.amountPaise, leftPaise: outstanding - input.amountPaise };
    return { revalidate: true, value };
  }));
});

export async function deleteCashSettlement(ctx: WriteContext, input: { settlementId: string }) {
  return runRelationalChange(ctx, "delete_cash_settlement", async (tx, helpers) => {
    const user = { id: ctx.actor.userId };
    const { assertSettlementOwned } = helpers;

    await assertSettlementOwned(user.id, input.settlementId);

    await tx
      .delete(schema.settlements)
      .where(and(eq(schema.settlements.id, input.settlementId), eq(schema.settlements.method, "cash")));

    return { revalidate: true, value: undefined };
  });
}

export async function writeOffParticipantShare(
  ctx: WriteContext,
  input: {
    splitParticipantId: string;
    note: string | null;
  },
) {
  return runRelationalChange(ctx, "write_off_participant_share", async (tx, helpers) => {
    const user = { id: ctx.actor.userId };
    const { assertSplitParticipantOwned, participantOutstanding } = helpers;

    await assertSplitParticipantOwned(user.id, input.splitParticipantId);

    const outstanding = await participantOutstanding(input.splitParticipantId);
    if (outstanding <= 0) {
      throw new LedgerError({ code: "invalid_input", message: "Nothing outstanding on this share to forgive." });
    }

    await tx.insert(schema.settlements).values({
      splitParticipantId: input.splitParticipantId,
      amountPaise: outstanding,
      method: "writeoff",
      inflowTransactionId: null,
      note: input.note?.trim() ? input.note.trim().slice(0, 200) : null,
    });

    return { revalidate: true, value: undefined };
  });
}

export async function undoWriteOff(ctx: WriteContext, input: { settlementId: string }) {
  return runRelationalChange(ctx, "undo_write_off", async (tx, helpers) => {
    const user = { id: ctx.actor.userId };
    const { assertSettlementOwned } = helpers;

    await assertSettlementOwned(user.id, input.settlementId);

    const [settlement] = await tx
      .select({ method: schema.settlements.method })
      .from(schema.settlements)
      .where(eq(schema.settlements.id, input.settlementId))
      .limit(1);
    if (!settlement || settlement.method !== "writeoff") {
      throw new LedgerError({ code: "invalid_input", message: "This settlement is not a writeoff and cannot be undone here." });
    }

    await tx
      .delete(schema.settlements)
      .where(and(eq(schema.settlements.id, input.settlementId), eq(schema.settlements.method, "writeoff")));

    return { revalidate: true, value: undefined };
  });
}
