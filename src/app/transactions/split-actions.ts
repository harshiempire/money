"use server";

import { eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { getOrCreatePerson } from "@/db/person";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import {
  assertSplitParticipantOwned,
  assertTransactionOwned,
} from "@/lib/auth/ownership";
import { settledAmountByParticipantIds } from "@/lib/splits/outstanding";

export interface ParticipantInput {
  // Existing participant id — pass back what the dialog was given for rows
  // that were kept, so the row (and its settlements) survive an edit.
  id?: string;
  personName: string;
  expectedAmountPaise: number;
}

const safePaise = (n: number, fallback = 0): number =>
  Number.isFinite(n) ? Math.round(n) : fallback;

const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

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
    id: p.id,
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

  if (yourSharePaise + participantsSum !== totalPaise) {
    const unaccounted = Math.abs(
      totalPaise - (yourSharePaise + participantsSum),
    );
    throw new Error(
      `Split doesn't balance: your share ${rupees(yourSharePaise)} + participants ${rupees(participantsSum)} = ${rupees(yourSharePaise + participantsSum)}, but total is ${rupees(totalPaise)} (${rupees(unaccounted)} unaccounted).`,
    );
  }

  const [existingSplit] = await db
    .select({ id: schema.splits.id })
    .from(schema.splits)
    .where(eq(schema.splits.transactionId, input.transactionId))
    .limit(1);

  // Read-only guard against destroying settled money. Must run before the
  // write transaction opens — settledAmountByParticipantIds queries the
  // global `db`, not a tx client.
  let existingParticipants: Array<{
    id: string;
    personName: string;
    expectedAmountPaise: number;
  }> = [];
  if (existingSplit) {
    existingParticipants = (
      await db
        .select({
          id: schema.splitParticipants.id,
          personName: schema.splitParticipants.personName,
          expectedAmountPaise: schema.splitParticipants.expectedAmountPaise,
        })
        .from(schema.splitParticipants)
        .where(eq(schema.splitParticipants.splitId, existingSplit.id))
    ).map((p) => ({ ...p, expectedAmountPaise: Number(p.expectedAmountPaise) }));

    const settledByParticipant = await settledAmountByParticipantIds(
      existingParticipants.map((p) => p.id),
    );
    const keptById = new Map(
      cleanParticipants
        .filter((p) => p.id)
        .map((p) => [p.id as string, p] as const),
    );

    for (const ep of existingParticipants) {
      const settled = settledByParticipant.get(ep.id) ?? 0;
      if (settled <= 0) continue;
      const kept = keptById.get(ep.id);
      if (!kept) {
        throw new Error(
          `Cannot remove ${ep.personName} — ${rupees(settled)} has already been settled against them. Clear that settlement first.`,
        );
      }
      // Only block edits that make an over-settlement worse. A share that is
      // already below what was settled (they overpaid) must stay editable —
      // otherwise one overpayment freezes the whole split, including edits
      // that move the share back toward what was actually received.
      if (
        kept.expectedAmountPaise < settled &&
        kept.expectedAmountPaise < ep.expectedAmountPaise
      ) {
        throw new Error(
          `Cannot reduce ${ep.personName}'s share to ${rupees(kept.expectedAmountPaise)} — ${rupees(settled)} is already settled against them.`,
        );
      }
    }
  }

  await db.transaction(async (tx) => {
    let splitId: string;
    if (existingSplit) {
      splitId = existingSplit.id;
      await tx
        .update(schema.splits)
        .set({ totalPaise, yourSharePaise, note: input.note })
        .where(eq(schema.splits.id, splitId));
    } else {
      const [split] = await tx
        .insert(schema.splits)
        .values({
          transactionId: input.transactionId,
          totalPaise,
          yourSharePaise,
          note: input.note,
        })
        .returning({ id: schema.splits.id });
      splitId = split.id;
    }

    const existingById = new Map(existingParticipants.map((p) => [p.id, p]));
    const keepIds = new Set<string>();
    for (const p of cleanParticipants) {
      const personId = await getOrCreatePerson(user.id, p.personName, tx);
      if (p.id && existingById.has(p.id)) {
        keepIds.add(p.id);
        await tx
          .update(schema.splitParticipants)
          .set({
            personName: p.personName,
            personId,
            expectedAmountPaise: p.expectedAmountPaise,
          })
          .where(eq(schema.splitParticipants.id, p.id));
      } else {
        await tx.insert(schema.splitParticipants).values({
          splitId,
          personId,
          personName: p.personName,
          expectedAmountPaise: p.expectedAmountPaise,
        });
      }
    }

    for (const ep of existingParticipants) {
      if (!keepIds.has(ep.id)) {
        await tx
          .delete(schema.splitParticipants)
          .where(eq(schema.splitParticipants.id, ep.id));
      }
    }
  });

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

  const cleanAllocations = input.allocations
    .map((a) => ({
      splitParticipantId: a.splitParticipantId,
      amountPaise: safePaise(a.amountPaise),
    }))
    .filter((a) => a.amountPaise > 0);

  const [inflow] = await db
    .select({ amountPaise: schema.transactions.amountPaise })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, input.inflowTransactionId))
    .limit(1);
  const inflowAmountPaise = inflow ? Number(inflow.amountPaise) : 0;

  const allocationsSum = cleanAllocations.reduce(
    (s, a) => s + a.amountPaise,
    0,
  );
  if (allocationsSum > inflowAmountPaise) {
    throw new Error(
      `Allocations total ${rupees(allocationsSum)}, which exceeds the inflow amount of ${rupees(inflowAmountPaise)}.`,
    );
  }

  if (cleanAllocations.length > 0) {
    const participantIds = [
      ...new Set(cleanAllocations.map((a) => a.splitParticipantId)),
    ];
    const participants = await db
      .select({
        id: schema.splitParticipants.id,
        personName: schema.splitParticipants.personName,
        expectedAmountPaise: schema.splitParticipants.expectedAmountPaise,
      })
      .from(schema.splitParticipants)
      .where(inArray(schema.splitParticipants.id, participantIds));
    const participantById = new Map(participants.map((p) => [p.id, p]));

    // Settled totals against these participants, excluding this same inflow's
    // own rows — this action deletes and reinserts that inflow's settlements,
    // so its own prior rows must not count against the outstanding balance.
    const settledExcludingThisInflow = new Map<string, number>();
    const priorSettlements = await db
      .select({
        splitParticipantId: schema.settlements.splitParticipantId,
        amountPaise: schema.settlements.amountPaise,
        inflowTransactionId: schema.settlements.inflowTransactionId,
      })
      .from(schema.settlements)
      .where(inArray(schema.settlements.splitParticipantId, participantIds));
    for (const row of priorSettlements) {
      if (!row.splitParticipantId) continue;
      if (row.inflowTransactionId === input.inflowTransactionId) continue;
      settledExcludingThisInflow.set(
        row.splitParticipantId,
        (settledExcludingThisInflow.get(row.splitParticipantId) ?? 0) +
          Number(row.amountPaise),
      );
    }

    const allocationByParticipant = new Map<string, number>();
    for (const a of cleanAllocations) {
      allocationByParticipant.set(
        a.splitParticipantId,
        (allocationByParticipant.get(a.splitParticipantId) ?? 0) +
          a.amountPaise,
      );
    }

    for (const [participantId, allocated] of allocationByParticipant) {
      const participant = participantById.get(participantId);
      if (!participant) continue;
      const expected = Number(participant.expectedAmountPaise);
      const settled = settledExcludingThisInflow.get(participantId) ?? 0;
      const outstanding = Math.max(0, expected - settled);
      if (allocated > outstanding) {
        throw new Error(
          `Allocation of ${rupees(allocated)} to ${participant.personName} exceeds their outstanding balance of ${rupees(outstanding)}.`,
        );
      }
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(schema.settlements)
      .where(
        eq(schema.settlements.inflowTransactionId, input.inflowTransactionId),
      );

    if (cleanAllocations.length > 0) {
      await tx.insert(schema.settlements).values(
        cleanAllocations.map((a) => ({
          inflowTransactionId: input.inflowTransactionId,
          splitParticipantId: a.splitParticipantId,
          amountPaise: a.amountPaise,
          method: "bank" as const,
        })),
      );
    }
  });

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
