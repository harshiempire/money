"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import {
  assertSettlementOwned,
  assertSplitParticipantOwned,
} from "@/lib/auth/ownership";
import { participantOutstanding } from "@/lib/splits/outstanding";

const safePaise = (n: number): number =>
  Number.isFinite(n) ? Math.round(n) : 0;

export async function recordCashSettlement(input: {
  splitParticipantId: string;
  amountPaise: number;
  note: string | null;
}) {
  const user = await requireCurrentUserAction();
  await assertSplitParticipantOwned(user.id, input.splitParticipantId);

  const [participant] = await db
    .select({
      expectedAmountPaise: schema.splitParticipants.expectedAmountPaise,
    })
    .from(schema.splitParticipants)
    .where(eq(schema.splitParticipants.id, input.splitParticipantId))
    .limit(1);
  if (!participant) return;

  const existing = await db
    .select({ amountPaise: schema.settlements.amountPaise })
    .from(schema.settlements)
    .where(eq(schema.settlements.splitParticipantId, input.splitParticipantId));

  const alreadySettled = existing.reduce(
    (sum, row) => sum + Number(row.amountPaise),
    0,
  );
  const outstanding = Math.max(
    0,
    Number(participant.expectedAmountPaise) - alreadySettled,
  );
  const amountPaise = Math.min(safePaise(input.amountPaise), outstanding);
  if (amountPaise <= 0) return;

  await db.insert(schema.settlements).values({
    splitParticipantId: input.splitParticipantId,
    amountPaise,
    method: "cash",
    note: input.note?.trim() ? input.note.trim().slice(0, 200) : null,
  });

  revalidatePath("/reimbursements");
  revalidatePath("/transactions");
  revalidatePath("/");
}

export async function deleteCashSettlement(input: { settlementId: string }) {
  const user = await requireCurrentUserAction();
  await assertSettlementOwned(user.id, input.settlementId);

  await db
    .delete(schema.settlements)
    .where(
      and(
        eq(schema.settlements.id, input.settlementId),
        eq(schema.settlements.method, "cash"),
      ),
    );

  revalidatePath("/reimbursements");
  revalidatePath("/transactions");
  revalidatePath("/");
}

// A writeoff is structurally a settlement like cash — it just records that no
// money moved, so the participant stops reading as outstanding for a shortfall
// you never intended to chase.
export async function writeOffParticipantShare(input: {
  splitParticipantId: string;
  note: string | null;
}) {
  const user = await requireCurrentUserAction();
  await assertSplitParticipantOwned(user.id, input.splitParticipantId);

  const outstanding = await participantOutstanding(input.splitParticipantId);
  if (outstanding <= 0) {
    throw new Error("Nothing outstanding on this share to forgive.");
  }

  await db.insert(schema.settlements).values({
    splitParticipantId: input.splitParticipantId,
    amountPaise: outstanding,
    method: "writeoff",
    inflowTransactionId: null,
    note: input.note?.trim() ? input.note.trim().slice(0, 200) : null,
  });

  revalidatePath("/reimbursements");
  revalidatePath("/transactions");
  revalidatePath("/people");
  revalidatePath("/");
}

// Reverses a mistaken writeoff. Refuses anything that isn't a writeoff so a
// misclick here can't quietly delete a real cash settlement.
export async function undoWriteOff(input: { settlementId: string }) {
  const user = await requireCurrentUserAction();
  await assertSettlementOwned(user.id, input.settlementId);

  const [settlement] = await db
    .select({ method: schema.settlements.method })
    .from(schema.settlements)
    .where(eq(schema.settlements.id, input.settlementId))
    .limit(1);
  if (!settlement || settlement.method !== "writeoff") {
    throw new Error("This settlement is not a writeoff and cannot be undone here.");
  }

  await db
    .delete(schema.settlements)
    .where(
      and(
        eq(schema.settlements.id, input.settlementId),
        eq(schema.settlements.method, "writeoff"),
      ),
    );

  revalidatePath("/reimbursements");
  revalidatePath("/transactions");
  revalidatePath("/people");
  revalidatePath("/");
}
