import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
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
import { schema } from "@/db";
import type { WriteContext } from "./context";
import { runRelationalChange, type RelationalHelpers } from "./relational-store";
export interface ParticipantInput {
  // Existing participant id — pass back what the dialog was given for rows
  // that were kept, so the row (and its settlements) survive an edit.
  id?: string;
  personName: string;
  expectedAmountPaise: number;
}

const safePaise = (n: number, fallback = 0): number => (Number.isFinite(n) ? Math.round(n) : fallback);
const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;
async function assertResidualPayableReplaceable(
  helpers: RelationalHelpers,
  inflowTransactionId: string,
) {
  const { settledAmountByOwedExpenseIds } = helpers;
  const payables = helpers.before.owed.filter(row => row.sourceInflowTransactionId === inflowTransactionId);
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
export async function createSplit(
  ctx: WriteContext,
  input: {
    transactionId: string;
    totalPaise: number;
    yourSharePaise: number;
    note: string | null;
    participants: ParticipantInput[];
    /** Refuse instead of editing when a split already exists (assistant cards). */
    expectNoExistingSplit?: boolean;
  },
) {
  return runRelationalChange(ctx, "create_split", async (tx, helpers) => {
    const user = { id: ctx.actor.userId };
    const { assertTransactionOwned, getOrCreatePerson, settledAmountByParticipantIds } = helpers;

    await assertTransactionOwned(user.id, input.transactionId);

    const cleanParticipants = input.participants.map((p) => ({
      id: p.id,
      personName: p.personName,
      expectedAmountPaise: safePaise(p.expectedAmountPaise),
    }));
    const totalPaise = safePaise(input.totalPaise);
    const participantsSum = cleanParticipants.reduce((s, p) => s + p.expectedAmountPaise, 0);
    const yourSharePaise = safePaise(input.yourSharePaise, Math.max(0, totalPaise - participantsSum));

    const valid = validateSplitInput({
      totalPaise,
      yourSharePaise,
      participants: cleanParticipants,
    });
    if (!valid.ok) throw new Error(valid.message);

    const [subject] = await tx
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

    const existingSplit = helpers.before.splits.find(row => row.transactionId === input.transactionId);
    if (existingSplit && input.expectNoExistingSplit) {
      throw new Error(
        "This payment already has a split. Edit it from the Split button in the table so settlements aren't lost.",
      );
    }

    // Re-check settled money under the relational locks.
    let existingParticipants: Array<{
      id: string;
      personName: string;
      expectedAmountPaise: number;
    }> = [];
    if (existingSplit) {
      existingParticipants = helpers.before.participants.filter(row => row.splitId === existingSplit.id).map((p) => ({
        ...p,
        expectedAmountPaise: Number(p.expectedAmountPaise),
      }));
    }

    const belongs = validateParticipantIdsBelongToSplit(
      cleanParticipants,
      new Set(existingParticipants.map((p) => p.id)),
    );
    if (!belongs.ok) throw new Error(belongs.message);

    if (existingParticipants.length > 0) {
      const settledByParticipant = await settledAmountByParticipantIds(existingParticipants.map((p) => p.id));
      const keptById = new Map(
        cleanParticipants.filter((p) => p.id).map((p) => [p.id as string, p] as const),
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

    {
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
          await tx.delete(schema.splitParticipants).where(eq(schema.splitParticipants.id, ep.id));
        }
      }
    }

    return { revalidate: true, value: undefined };
  });
}

export async function deleteSplit(
  ctx: WriteContext,
  input: {
    transactionId: string;
    /** Refuse if any money was settled against the split (assistant Undo). */
    expectNoSettlements?: boolean;
  },
) {
  return runRelationalChange(ctx, "delete_split", async (tx, helpers) => {
    const user = { id: ctx.actor.userId };
    const { assertTransactionOwned } = helpers;

    await assertTransactionOwned(user.id, input.transactionId);

    const existing = helpers.before.splits.filter(row => row.transactionId === input.transactionId);
    if (existing.length === 0) return { revalidate: false, value: undefined };

    // Deleting the split cascades its participants and their settlements away.
    // Any credit that was settling one of them had its leftover measured
    // against those allocations, so that figure is about to become a claim
    // about money we can no longer account for — collect the credits now,
    // while the settlements still exist, and reset them below.
    const splitIds = new Set(existing.map(row => row.id));
    const participants = helpers.before.participants.filter(row => splitIds.has(row.splitId));

    let affectedInflowIds: string[] = [];
    if (participants.length > 0) {
      const participantIds = new Set(participants.map(row => row.id));
      const rows = helpers.before.settlements.filter(row => row.splitParticipantId !== null && participantIds.has(row.splitParticipantId));
      if (input.expectNoSettlements && rows.length > 0) {
        throw new Error("Money was settled against this split since. Remove it from the table instead.");
      }
      affectedInflowIds = [
        ...new Set(rows.map((r) => r.inflowTransactionId).filter((id): id is string => id !== null)),
      ];
    }

    {
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
    }

    return { revalidate: true, value: undefined };
  });
}

export async function recordSettlement(
  ctx: WriteContext,
  input: {
    inflowTransactionId: string;
    allocations: Array<{ splitParticipantId: string; amountPaise: number }>;
    residual?: {
      kind: "owed_back" | "kept" | "written_off";
      personName?: string;
      note?: string | null;
    } | null;
  },
) {
  return runRelationalChange(ctx, "record_settlement", async (tx, helpers) => {
    const user = { id: ctx.actor.userId };
    const { assertTransactionOwned, assertSplitParticipantOwned, getOrCreatePerson } = helpers;

    await assertTransactionOwned(user.id, input.inflowTransactionId);

    for (const a of input.allocations) {
      await assertSplitParticipantOwned(user.id, a.splitParticipantId);
    }

    const cleaned = cleanAllocations(
      input.allocations.map((a) => ({
        splitParticipantId: a.splitParticipantId,
        amountPaise: a.amountPaise,
      })),
    );
    if (!cleaned.ok) throw new Error(cleaned.message);
    const allocations = cleaned.allocations;

    const [inflow] = await tx
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

    await assertResidualPayableReplaceable(helpers, input.inflowTransactionId);

    const inflowAmountPaise = inflow ? Number(inflow.amountPaise) : 0;

    // A Net Settle can spend part of this same credit through a bank leg. Those
    // rows carry a net_event_id and belong to the net event, not to this
    // dialog: this action never deletes them, and can only allocate what they
    // left over.
    const netRowsOnInflow = helpers.before.settlements.filter(row => row.inflowTransactionId === input.inflowTransactionId && row.netEventId !== null);
    const reservedByNetSettlePaise = netRowsOnInflow.reduce((s, r) => s + Number(r.amountPaise), 0);

    const allocationsSum = allocations.reduce((s, a) => s + a.amountPaise, 0);
    const capacity = validateInflowCapacity({
      inflowAmountPaise,
      reservedByNetSettlePaise,
      allocationsSumPaise: allocationsSum,
    });
    if (!capacity.ok) throw new Error(capacity.message);

    if (allocations.length > 0) {
      const participantIds = [...new Set(allocations.map((a) => a.splitParticipantId))];
      const selected = new Set(participantIds);
      const participants = helpers.before.participants.filter(row => selected.has(row.id));
      const participantById = new Map(participants.map((p) => [p.id, p]));

      // Settled totals against these participants, excluding the rows this
      // action is about to replace: this inflow's own plain settlements. Net
      // Settle rows on this inflow stay put, so they still count.
      const settledExcludingThisInflow = new Map<string, number>();
      const priorSettlements = helpers.before.settlements.filter(row => row.splitParticipantId !== null && selected.has(row.splitParticipantId));
      for (const row of priorSettlements) {
        if (!row.splitParticipantId) continue;
        if (row.inflowTransactionId === input.inflowTransactionId && row.netEventId === null) {
          continue;
        }
        settledExcludingThisInflow.set(
          row.splitParticipantId,
          (settledExcludingThisInflow.get(row.splitParticipantId) ?? 0) + Number(row.amountPaise),
        );
      }

      const allocationByParticipant = new Map<string, number>();
      for (const a of allocations) {
        allocationByParticipant.set(
          a.splitParticipantId,
          (allocationByParticipant.get(a.splitParticipantId) ?? 0) + a.amountPaise,
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

    {
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
        .where(eq(schema.owedExpenses.sourceInflowTransactionId, input.inflowTransactionId));
      await tx
        .update(schema.transactions)
        .set({ residualDisposition: null, residualAcknowledgedPaise: null })
        .where(eq(schema.transactions.id, input.inflowTransactionId));

      const residualPaise = inflowAmountPaise - reservedByNetSettlePaise - allocationsSum;
      if (input.residual && residualPaise > 0) {
        if (input.residual.kind === "owed_back") {
          const personName = input.residual.personName?.trim();
          if (!personName) {
            throw new Error("A person name is required to record an overpayment as owed back.");
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
    }

    return { revalidate: true, value: undefined };
  });
}

export async function clearSettlement(ctx: WriteContext, input: { inflowTransactionId: string }) {
  return runRelationalChange(ctx, "clear_settlement", async (tx, helpers) => {
    const user = { id: ctx.actor.userId };
    const { assertTransactionOwned } = helpers;

    await assertTransactionOwned(user.id, input.inflowTransactionId);
    await assertResidualPayableReplaceable(helpers, input.inflowTransactionId);

    {
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
        .where(eq(schema.owedExpenses.sourceInflowTransactionId, input.inflowTransactionId));
      await tx
        .update(schema.transactions)
        .set({ residualDisposition: null, residualAcknowledgedPaise: null })
        .where(eq(schema.transactions.id, input.inflowTransactionId));
    }

    return { revalidate: true, value: undefined };
  });
}
