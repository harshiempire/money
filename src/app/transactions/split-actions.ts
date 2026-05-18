"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { getOrCreatePerson } from "@/db/person";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import {
  assertSplitParticipantOwned,
  assertTransactionOwned,
} from "@/lib/auth/ownership";

export interface ParticipantInput {
  personName: string;
  expectedAmountPaise: number;
}

const safePaise = (n: number, fallback = 0): number =>
  Number.isFinite(n) ? Math.round(n) : fallback;

export async function createSplit(input: {
  transactionId: string;
  totalPaise: number;
  yourSharePaise: number;
  note: string | null;
  participants: ParticipantInput[];
}) {
  const user = await requireCurrentUserAction();
  await assertTransactionOwned(user.id, input.transactionId);

  const cleanParticipants = input.participants.map((p) => ({
    personName: p.personName,
    expectedAmountPaise: safePaise(p.expectedAmountPaise),
  }));
  const totalPaise = safePaise(input.totalPaise);
  const participantsSum = cleanParticipants.reduce(
    (s, p) => s + p.expectedAmountPaise,
    0,
  );
  const yourSharePaise = safePaise(
    input.yourSharePaise,
    Math.max(0, totalPaise - participantsSum),
  );

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
    const rows = [];
    for (const p of cleanParticipants) {
      const personId = await getOrCreatePerson(user.id, p.personName);
      rows.push({
        splitId: split.id,
        personId,
        personName: p.personName,
        expectedAmountPaise: p.expectedAmountPaise,
      });
    }
    await db.insert(schema.splitParticipants).values(rows);
  }

  revalidatePath("/transactions");
  revalidatePath("/reimbursements");
  revalidatePath("/");
}

export async function deleteSplit(input: { transactionId: string }) {
  const user = await requireCurrentUserAction();
  await assertTransactionOwned(user.id, input.transactionId);

  const existing = await db
    .select({ id: schema.splits.id })
    .from(schema.splits)
    .where(eq(schema.splits.transactionId, input.transactionId));
  for (const s of existing) {
    await db.delete(schema.splits).where(eq(schema.splits.id, s.id));
  }
  revalidatePath("/transactions");
  revalidatePath("/reimbursements");
  revalidatePath("/");
}

export async function recordSettlement(input: {
  inflowTransactionId: string;
  allocations: Array<{ splitParticipantId: string; amountPaise: number }>;
}) {
  const user = await requireCurrentUserAction();
  await assertTransactionOwned(user.id, input.inflowTransactionId);

  for (const a of input.allocations) {
    await assertSplitParticipantOwned(user.id, a.splitParticipantId);
  }

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
        method: "bank" as const,
      })),
    );
  }

  revalidatePath("/transactions");
  revalidatePath("/reimbursements");
  revalidatePath("/");
}

export async function clearSettlement(input: { inflowTransactionId: string }) {
  const user = await requireCurrentUserAction();
  await assertTransactionOwned(user.id, input.inflowTransactionId);

  await db
    .delete(schema.settlements)
    .where(
      eq(schema.settlements.inflowTransactionId, input.inflowTransactionId),
    );
  revalidatePath("/transactions");
  revalidatePath("/reimbursements");
  revalidatePath("/");
}
