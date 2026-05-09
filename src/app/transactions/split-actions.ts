"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";

export interface ParticipantInput {
  personName: string;
  expectedAmountPaise: number;
}

/**
 * Create a split for a debit transaction. Replaces any prior split on the
 * same transaction (delete-then-insert) so editing is just "save again".
 *
 * Constraint: yourSharePaise + sum(expected) does NOT have to equal total —
 * we tolerate the bank's rounding and partial reimbursements.
 */
export async function createSplit(input: {
  transactionId: string;
  totalPaise: number;
  yourSharePaise: number;
  note: string | null;
  participants: ParticipantInput[];
}) {
  // Drop any existing split first; cascades remove participants and settlements.
  const existing = await db
    .select({ id: schema.splits.id })
    .from(schema.splits)
    .where(eq(schema.splits.transactionId, input.transactionId));
  for (const s of existing) {
    await db.delete(schema.splits).where(eq(schema.splits.id, s.id));
  }

  const [split] = await db
    .insert(schema.splits)
    .values({
      transactionId: input.transactionId,
      totalPaise: input.totalPaise,
      yourSharePaise: input.yourSharePaise,
      note: input.note,
    })
    .returning({ id: schema.splits.id });

  if (input.participants.length > 0) {
    await db.insert(schema.splitParticipants).values(
      input.participants.map((p) => ({
        splitId: split.id,
        personName: p.personName,
        expectedAmountPaise: p.expectedAmountPaise,
      })),
    );
  }

  revalidatePath("/transactions");
  revalidatePath("/");
}

export async function deleteSplit(input: { transactionId: string }) {
  const existing = await db
    .select({ id: schema.splits.id })
    .from(schema.splits)
    .where(eq(schema.splits.transactionId, input.transactionId));
  for (const s of existing) {
    await db.delete(schema.splits).where(eq(schema.splits.id, s.id));
  }
  revalidatePath("/transactions");
  revalidatePath("/");
}

/**
 * Mark an inflow transaction as a settlement against one or more split
 * participants. Replaces any prior settlements on the same inflow.
 */
export async function recordSettlement(input: {
  inflowTransactionId: string;
  allocations: Array<{ splitParticipantId: string; amountPaise: number }>;
}) {
  await db
    .delete(schema.settlements)
    .where(
      eq(schema.settlements.inflowTransactionId, input.inflowTransactionId),
    );

  if (input.allocations.length > 0) {
    await db.insert(schema.settlements).values(
      input.allocations.map((a) => ({
        inflowTransactionId: input.inflowTransactionId,
        splitParticipantId: a.splitParticipantId,
        amountPaise: a.amountPaise,
      })),
    );
  }

  revalidatePath("/transactions");
  revalidatePath("/");
}

export async function clearSettlement(input: { inflowTransactionId: string }) {
  await db
    .delete(schema.settlements)
    .where(
      eq(schema.settlements.inflowTransactionId, input.inflowTransactionId),
    );
  revalidatePath("/transactions");
  revalidatePath("/");
}
