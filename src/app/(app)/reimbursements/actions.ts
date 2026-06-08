"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import {
  assertSettlementOwned,
  assertSplitParticipantOwned,
} from "@/lib/auth/ownership";

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
