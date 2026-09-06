"use server";

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
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
  cleanAllocations,
  validateInflowCapacity,
  validateParticipantIdsBelongToSplit,
  validatePayableReplaceable,
  validateSettledParticipantEdit,
  validateSettlementSource,
  validateSplitInput,
  validateSplitTotalMatchesTransaction,
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
    .select({
      drCr: schema.transactions.drCr,
      amountPaise: schema.transactions.amountPaise,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, input.transactionId))
    .limit(1);
  if (subject?.drCr !== "debit") {
    throw new Error("Only a payment you made can be split.");
  }

  // The total isn't the client's to decide — it is the transaction's amount.
  const totalMatches = validateSplitTotalMatchesTransaction({
    totalPaise,
    transactionAmountPaise: Number(subject.amountPaise),
  });
  if (!totalMatches.ok) throw new Error(totalMatches.message);

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
  }

  // Every id the client sent back must be a row on this split. Ownership of
  // the transaction is already established; this pins the participant rows
  // to it too, instead of quietly treating a foreign id as a brand-new row.
  const belongs = validateParticipantIdsBelongToSplit(
    cleanParticipants,
    new Set(existingParticipants.map((p) => p.id)),
  );
  if (!belongs.ok) throw new Error(belongs.message);

  if (existingParticipants.length > 0) {
    const settledByParticipant = await settledAmountByParticipantIds(
      existingParticipants.map((p) => p.id),
    );
    const keptById = new Map(
      cleanParticipants
        .filter((p) => p.id)
        .map((p) => [p.id as string, p] as const),
    );

    for (const ep of existingParticipants) {
      const check = validateSettledParticipantEdit({
        existing: ep,
        kept: keptById.get(ep.id),
        settledPaise: settledByParticipant.get(ep.id) ?? 0,
      });
      if (!check.ok) throw new Error(check.message);
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

  // Validate the raw amounts before any row is dropped — a negative or
  // non-numeric amount must fail the request, not vanish and leave an empty
  // list that then wipes the credit's existing allocations.
  const cleaned = cleanAllocations(
    input.allocations.map((a) => ({
      splitParticipantId: a.splitParticipantId,
      amountPaise: a.amountPaise,
    })),
  );
  if (!cleaned.ok) throw new Error(cleaned.message);
  const allocations = cleaned.allocations;

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

  // A Net Settle can spend part of this same credit through a bank leg. Those
  // rows carry a net_event_id and belong to the net event, not to this
  // dialog: this action never deletes them, and can only allocate what they
  // left over.
  const netRowsOnInflow = await db
    .select({ amountPaise: schema.settlements.amountPaise })
    .from(schema.settlements)
    .where(
      and(
        eq(schema.settlements.inflowTransactionId, input.inflowTransactionId),
        isNotNull(schema.settlements.netEventId),
      ),
    );
  const reservedByNetSettlePaise = netRowsOnInflow.reduce(
    (s, r) => s + Number(r.amountPaise),
    0,
  );

  const allocationsSum = allocations.reduce((s, a) => s + a.amountPaise, 0);
  const capacity = validateInflowCapacity({
    inflowAmountPaise,
    reservedByNetSettlePaise,
    allocationsSumPaise: allocationsSum,
  });
  if (!capacity.ok) throw new Error(capacity.message);

  if (allocations.length > 0) {
    const participantIds = [
      ...new Set(allocations.map((a) => a.splitParticipantId)),
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

    // Settled totals against these participants, excluding the rows this
    // action is about to replace: this inflow's own plain settlements. Net
    // Settle rows on this inflow stay put, so they still count.
    const settledExcludingThisInflow = new Map<string, number>();
    const priorSettlements = await db
      .select({
        splitParticipantId: schema.settlements.splitParticipantId,
        amountPaise: schema.settlements.amountPaise,
        inflowTransactionId: schema.settlements.inflowTransactionId,
        netEventId: schema.settlements.netEventId,
      })
      .from(schema.settlements)
      .where(inArray(schema.settlements.splitParticipantId, participantIds));
    for (const row of priorSettlements) {
      if (!row.splitParticipantId) continue;
      if (
        row.inflowTransactionId === input.inflowTransactionId &&
        row.netEventId === null
      ) {
        continue;
      }
      settledExcludingThisInflow.set(
        row.splitParticipantId,
        (settledExcludingThisInflow.get(row.splitParticipantId) ?? 0) +
          Number(row.amountPaise),
      );
    }

    const allocationByParticipant = new Map<string, number>();
    for (const a of allocations) {
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
    // Only this dialog's own rows. A row with a net_event_id was written by
    // Net Settle and is deleted only through that event.
    await tx
      .delete(schema.settlements)
      .where(
        and(
          eq(schema.settlements.inflowTransactionId, input.inflowTransactionId),
          isNull(schema.settlements.netEventId),
        ),
      );

    if (allocations.length > 0) {
      await tx.insert(schema.settlements).values(
        allocations.map((a) => ({
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

    const residualPaise =
      inflowAmountPaise - reservedByNetSettlePaise - allocationsSum;
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
    // Same scope as recordSettlement: Net Settle's rows on this credit are
    // not this dialog's to clear.
    await tx
      .delete(schema.settlements)
      .where(
        and(
          eq(schema.settlements.inflowTransactionId, input.inflowTransactionId),
          isNull(schema.settlements.netEventId),
        ),
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
