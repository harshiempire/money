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
// Coerce a possibly-NaN/Infinity number to a safe integer at the server
// boundary — Postgres bigint columns reject "NaN" strings.
const safePaise = (n: number, fallback = 0): number =>
  Number.isFinite(n) ? Math.round(n) : fallback;

export async function createSplit(input: {
  transactionId: string;
  totalPaise: number;
  yourSharePaise: number;
  note: string | null;
  participants: ParticipantInput[];
}) {
  // Sanitize numeric inputs so a buggy/old client can't crash the insert.
  const cleanParticipants = input.participants.map((p) => ({
    personName: p.personName,
    expectedAmountPaise: safePaise(p.expectedAmountPaise),
  }));
  const totalPaise = safePaise(input.totalPaise);
  // If yourSharePaise is NaN/Infinity, fall back to total minus sum of
  // participant shares (the "I paid the rest" interpretation).
  const participantsSum = cleanParticipants.reduce(
    (s, p) => s + p.expectedAmountPaise,
    0,
  );
  const yourSharePaise = safePaise(
    input.yourSharePaise,
    Math.max(0, totalPaise - participantsSum),
  );

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
      totalPaise,
      yourSharePaise,
      note: input.note,
    })
    .returning({ id: schema.splits.id });

  if (cleanParticipants.length > 0) {
    await db.insert(schema.splitParticipants).values(
      cleanParticipants.map((p) => ({
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

  const cleanAllocations = input.allocations
    .map((a) => ({
      splitParticipantId: a.splitParticipantId,
      amountPaise: safePaise(a.amountPaise),
    }))
    .filter((a) => a.amountPaise > 0);

  if (cleanAllocations.length > 0) {
    await db.insert(schema.settlements).values(
      cleanAllocations.map((a) => ({
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
