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
import {
  settledAmountByOwedExpenseIds,
  settledAmountByParticipantIds,
} from "@/lib/splits/outstanding";
import {
  validateAllocationAmounts,
  validatePayableReplaceable,
  validateSettlementSource,
  validateSplitInput,
} from "@/lib/splits/validate";

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

  const valid = validateSplitInput({
    totalPaise,
    yourSharePaise,
    participants: cleanParticipants,
  });
  if (!valid.ok) throw new Error(valid.message);

  // A split divides money you paid out. Splitting an incoming credit would
  // record a share of a payment that never happened.
  const [subject] = await db
    .select({ drCr: schema.transactions.drCr })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, input.transactionId))
    .limit(1);
  if (subject?.drCr !== "debit") {
    throw new Error("Only a payment you made can be split.");
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
  if (existing.length === 0) return;

  // Deleting the split cascades its participants and their settlements away.
  // Any credit that was settling one of them had its leftover measured
  // against those allocations, so that figure is about to become a claim
  // about money we can no longer account for — collect the credits now,
  // while the settlements still exist, and reset them below.
  const participants = await db
    .select({ id: schema.splitParticipants.id })
    .from(schema.splitParticipants)
    .where(
      inArray(
        schema.splitParticipants.splitId,
        existing.map((s) => s.id),
      ),
    );

  let affectedInflowIds: string[] = [];
  if (participants.length > 0) {
    const rows = await db
      .select({ inflowTransactionId: schema.settlements.inflowTransactionId })
      .from(schema.settlements)
      .where(
        inArray(
          schema.settlements.splitParticipantId,
          participants.map((p) => p.id),
        ),
      );
    affectedInflowIds = [
      ...new Set(
        rows
          .map((r) => r.inflowTransactionId)
          .filter((id): id is string => id !== null),
      ),
    ];
  }

  await db.transaction(async (tx) => {
    for (const s of existing) {
      await tx.delete(schema.splits).where(eq(schema.splits.id, s.id));
    }
    // The payables stay: money you owe someone doesn't stop being owed
    // because the split it came from was removed. Only the acknowledgement,
    // whose amount was derived from the deleted allocations, is reset — the
    // credit goes back to reading as unexplained so it gets answered again.
    if (affectedInflowIds.length > 0) {
      await tx
        .update(schema.transactions)
        .set({ residualDisposition: null, residualAcknowledgedPaise: null })
        .where(inArray(schema.transactions.id, affectedInflowIds));
    }
  });

  revalidatePath("/transactions");
  revalidatePath("/reimbursements");
  revalidatePath("/people");
  revalidatePath("/");
}

/**
 * Replacing a credit's leftover deletes the payable an overpayment created,
 * and `settlement.owed_expense_id` cascades — so any record of that payable
 * being repaid would go with it. Refuse instead, the same way removing a
 * settled participant is refused.
 */
async function assertResidualPayableReplaceable(inflowTransactionId: string) {
  const payables = await db
    .select({
      id: schema.owedExpenses.id,
      personName: schema.owedExpenses.personName,
    })
    .from(schema.owedExpenses)
    .where(
      eq(schema.owedExpenses.sourceInflowTransactionId, inflowTransactionId),
    );
  if (payables.length === 0) return;

  const settled = await settledAmountByOwedExpenseIds(payables.map((e) => e.id));
  for (const payable of payables) {
    const check = validatePayableReplaceable({
      personName: payable.personName,
      settledPaise: settled.get(payable.id) ?? 0,
    });
    if (!check.ok) throw new Error(check.message);
  }
}

export async function recordSettlement(input: {
  inflowTransactionId: string;
  allocations: Array<{ splitParticipantId: string; amountPaise: number }>;
  residual?: {
    kind: "owed_back" | "kept" | "written_off";
    personName?: string;
    note?: string | null;
  } | null;
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

  const amounts = validateAllocationAmounts(cleanAllocations);
  if (!amounts.ok) throw new Error(amounts.message);

  // The outstanding/inflow reads below happen before the write transaction and
  // take no row locks, so two settlements saved at the same instant could each
  // see the same amount as unspent. Single-user app, one browser session — the
  // window doesn't arise in practice. Take row locks here if that changes.

  const [inflow] = await db
    .select({
      amountPaise: schema.transactions.amountPaise,
      txnDate: schema.transactions.txnDate,
      drCr: schema.transactions.drCr,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, input.inflowTransactionId))
    .limit(1);

  const source = validateSettlementSource(inflow?.drCr);
  if (!source.ok) throw new Error(source.message);

  await assertResidualPayableReplaceable(input.inflowTransactionId);

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

    // Clear any previous disposition first so re-saving is idempotent and
    // switching your answer (e.g. "kept" -> "owed back") doesn't leave a
    // stale owed_expense or acknowledgement behind.
    await tx
      .delete(schema.owedExpenses)
      .where(
        eq(
          schema.owedExpenses.sourceInflowTransactionId,
          input.inflowTransactionId,
        ),
      );
    await tx
      .update(schema.transactions)
      .set({ residualDisposition: null, residualAcknowledgedPaise: null })
      .where(eq(schema.transactions.id, input.inflowTransactionId));

    const residualPaise = inflowAmountPaise - allocationsSum;
    if (input.residual && residualPaise > 0) {
      if (input.residual.kind === "owed_back") {
        const personName = input.residual.personName?.trim();
        if (!personName) {
          throw new Error(
            "A person name is required to record an overpayment as owed back.",
          );
        }
        const personId = await getOrCreatePerson(user.id, personName, tx);
        await tx.insert(schema.owedExpenses).values({
          userId: user.id,
          personId,
          personName,
          incurredDate: inflow?.txnDate ?? new Date().toISOString().slice(0, 10),
          amountPaise: residualPaise,
          description: `Overpayment from ${personName}`,
          note: input.residual.note ?? null,
          sourceInflowTransactionId: input.inflowTransactionId,
        });
      } else {
        await tx
          .update(schema.transactions)
          .set({
            residualDisposition: input.residual.kind,
            residualAcknowledgedPaise: residualPaise,
          })
          .where(eq(schema.transactions.id, input.inflowTransactionId));
      }
    }
  });

  revalidatePath("/transactions");
  revalidatePath("/reimbursements");
  revalidatePath("/people");
  revalidatePath("/");
}

export async function clearSettlement(input: { inflowTransactionId: string }) {
  const user = await requireCurrentUserAction();
  await assertTransactionOwned(user.id, input.inflowTransactionId);
  await assertResidualPayableReplaceable(input.inflowTransactionId);

  await db.transaction(async (tx) => {
    await tx
      .delete(schema.settlements)
      .where(
        eq(schema.settlements.inflowTransactionId, input.inflowTransactionId),
      );
    // Clearing the settlement should not leave an orphan overpayment payable
    // or a stale acknowledged amount behind — the credit goes back to
    // reading as unexplained.
    await tx
      .delete(schema.owedExpenses)
      .where(
        eq(
          schema.owedExpenses.sourceInflowTransactionId,
          input.inflowTransactionId,
        ),
      );
    await tx
      .update(schema.transactions)
      .set({ residualDisposition: null, residualAcknowledgedPaise: null })
      .where(eq(schema.transactions.id, input.inflowTransactionId));
  });

  revalidatePath("/transactions");
  revalidatePath("/reimbursements");
  revalidatePath("/people");
  revalidatePath("/");
}
