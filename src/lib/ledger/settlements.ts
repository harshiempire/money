import "server-only";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { LedgerError, type WriteContext } from "./context";
import { runRelationalChange } from "./relational-store";

const safePaise = (n: number, fallback = 0): number => (Number.isFinite(n) ? Math.round(n) : fallback);

export async function recordCashSettlement(
  ctx: WriteContext,
  input: {
    splitParticipantId: string;
    amountPaise: number;
    note: string | null;
  },
) {
  return runRelationalChange(ctx, "record_cash_settlement", async (tx, helpers) => {
    const user = { id: ctx.actor.userId };
    const { assertSplitParticipantOwned } = helpers;

    await assertSplitParticipantOwned(user.id, input.splitParticipantId);

    const participant = helpers.before.participants.find(row => row.id === input.splitParticipantId);
    if (!participant) return { revalidate: false, value: undefined };

    const existing = helpers.before.settlements.filter(row => row.splitParticipantId === input.splitParticipantId);

    const alreadySettled = existing.reduce((sum, row) => sum + Number(row.amountPaise), 0);
    const outstanding = Math.max(0, Number(participant.expectedAmountPaise) - alreadySettled);
    const amountPaise = Math.min(safePaise(input.amountPaise), outstanding);
    if (amountPaise <= 0) return { revalidate: false, value: undefined };

    await tx.insert(schema.settlements).values({
      splitParticipantId: input.splitParticipantId,
      amountPaise,
      method: "cash",
      note: input.note?.trim() ? input.note.trim().slice(0, 200) : null,
    });

    return { revalidate: true, value: undefined };
  });
}

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
