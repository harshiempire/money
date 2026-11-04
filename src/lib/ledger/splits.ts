import "server-only";
import { Effect } from "effect";
import { Actor } from "./services";
import { ledgerQuery, runRelationalChangeEffect } from "./relational-store";
import { outstandingPaise, personBalanceKey } from "./rules/balances";
import { allocateOldestFirst, validateAllocations, inflowExplanation, appendAllowed, sameAllocations, settlementReceipt, type Allocation } from "./rules/settlement-policy";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  cleanAllocations,
  validateParticipantIdsBelongToSplit,
  validatePayableReplaceable,
  validateSettledParticipantEdit,
  validateSplitInput,
  validateSplitTotalMatchesTransaction,
} from "@/lib/splits/validate";
import { schema } from "@/db";
import { LedgerError, type WriteContext } from "./context";
import { runRelationalChange, type RelationalHelpers } from "./relational-store";
import type { ParticipantInput } from "@/lib/splits/types";
export type { ParticipantInput } from "@/lib/splits/types";

const safePaise = (n: number, fallback = 0): number => (Number.isFinite(n) ? Math.round(n) : fallback);
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
    if (!check.ok) throw new LedgerError({ code: "invalid_input", message: check.message });
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
    if (!valid.ok) throw new LedgerError({ code: "invalid_input", message: valid.message });

    const [subject] = await tx
      .select({
        drCr: schema.transactions.drCr,
        amountPaise: schema.transactions.amountPaise,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, input.transactionId))
      .limit(1);
    if (subject?.drCr !== "debit") {
      throw new LedgerError({ code: "invalid_input", message: "Only a payment you made can be split." });
    }

    // The total isn't the client's to decide — it is the transaction's amount.
    const totalMatches = validateSplitTotalMatchesTransaction({
      totalPaise,
      transactionAmountPaise: Number(subject.amountPaise),
    });
    if (!totalMatches.ok) throw new LedgerError({ code: "invalid_input", message: totalMatches.message });

    const existingSplit = helpers.before.splits.find(row => row.transactionId === input.transactionId);
    if (existingSplit && input.expectNoExistingSplit) {
      throw new LedgerError({ code: "invalid_input", message: "This payment already has a split. Edit it from the Split button in the table so settlements aren't lost." });
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
    if (!belongs.ok) throw new LedgerError({ code: "invalid_input", message: belongs.message });

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
        if (!check.ok) throw new LedgerError({ code: "invalid_input", message: check.message });
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
        throw new LedgerError({ code: "invalid_input", message: "Money was settled against this split since. Remove it from the table instead." });
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

export interface RecordSettlementInput {
  inflowTransactionId: string;
  mode?: "replace" | "append";
  expected?: { allocations: Allocation[] };
  allocations: { kind: "explicit"; rows: Allocation[] } | { kind: "oldest_first"; personName: string; limitPaise?: number };
  residual?: { kind: "owed_back" | "kept" | "written_off"; personName?: string; note?: string | null } | null;
}
export const recordSettlement = Effect.fn("recordSettlement")(function* (
  context: WriteContext, input: RecordSettlementInput,
) {
  const actor = yield* Actor;
  const ctx = { ...context, actor };
  return yield* runRelationalChangeEffect(ctx, "record_settlement", (tx, helpers) => Effect.gen(function* () {
    const user = { id: actor.userId };
    const mode = input.mode ?? "replace";
    yield* ledgerQuery(() => helpers.assertTransactionOwned(user.id, input.inflowTransactionId));
    const [inflow] = yield* ledgerQuery(() => tx.select().from(schema.transactions).where(eq(schema.transactions.id, input.inflowTransactionId)));
    if (inflow.drCr !== "credit") return yield* new LedgerError({ code: "invalid_source", message: "Only an incoming credit can settle shares." });
    const plain = helpers.before.settlements.filter(r => r.inflowTransactionId === input.inflowTransactionId && r.netEventId === null);
    if (input.expected && !sameAllocations(input.expected.allocations, plain.map(r => ({ splitParticipantId: r.splitParticipantId!, amountPaise: r.amountPaise }))))
      return yield* new LedgerError({ code: "stale", message: "This payment's allocations changed since you opened it. Reload and review." });
    const reservedByNetSettlePaise = helpers.before.settlements.filter(r => r.inflowTransactionId === inflow.id && r.netEventId !== null).reduce((n,r) => n + r.amountPaise, 0);
    const netEvents = yield* ledgerQuery(() => tx.select().from(schema.netEvents).where(or(eq(schema.netEvents.inflowTransactionId, inflow.id), eq(schema.netEvents.outflowTransactionId, inflow.id))));
    const explanation = inflowExplanation({ inflowAmountPaise: Number(inflow.amountPaise), allocations: plain, netReservedPaise: reservedByNetSettlePaise,
      owedSourced: helpers.before.owed.some(r => r.sourceInflowTransactionId === inflow.id), residualDisposition: inflow.residualDisposition,
      residualAcknowledgedPaise: inflow.residualAcknowledgedPaise, hasNetEvent: reservedByNetSettlePaise > 0 || netEvents.length > 0 });
    if (mode === "append") {
      if (input.residual !== undefined) return yield* new LedgerError({ code: "invalid_input", message: "Append mode cannot set a leftover disposition." });
      const allowed = appendAllowed(explanation);
      if (!allowed.ok) return yield* new LedgerError(allowed);
    } else yield* ledgerQuery(() => assertResidualPayableReplaceable(helpers, inflow.id));
    const available = mode === "append" ? explanation.availablePaise : Number(inflow.amountPaise) - reservedByNetSettlePaise;
    const selection = input.allocations;
    const nameKey = selection.kind === "oldest_first" ? personBalanceKey(null, selection.personName, helpers.before.people) : null;
    const bills = yield* ledgerQuery(() => tx.select({ id: schema.transactions.id, date: schema.transactions.txnDate }).from(schema.transactions).where(inArray(schema.transactions.id, helpers.before.splits.map(s => s.transactionId))));
    const open = helpers.before.participants.filter(p => nameKey === null || personBalanceKey(p.personId, p.personName, helpers.before.people) === nameKey).map(p => {
      const split = helpers.before.splits.find(s => s.id === p.splitId)!;
      const paid = helpers.before.settlements.filter(r => r.splitParticipantId === p.id && !(mode === "replace" && r.inflowTransactionId === inflow.id && r.netEventId === null));
      return { id: p.id, date: bills.find(b => b.id === split.transactionId)!.date, order: split.createdAt,
        leftPaise: outstandingPaise(p.expectedAmountPaise, paid) ?? -1 };
    });
    let checked;
    if (selection.kind === "oldest_first") {
      const limit = selection.limitPaise ?? available;
      if (!Number.isSafeInteger(limit) || limit < 0) return yield* new LedgerError({ code: "invalid_amount", message: "Allocations must be positive exact paise." });
      checked = allocateOldestFirst(Math.min(available, limit), open);
    } else {
      for (const row of selection.rows) yield* ledgerQuery(() => helpers.assertSplitParticipantOwned(user.id, row.splitParticipantId));
      const cleaned = cleanAllocations(selection.rows);
      if (!cleaned.ok) return yield* new LedgerError({ code: "invalid_input", message: cleaned.message });
      checked = validateAllocations(available, open, cleaned.allocations.map(r => ({ id: r.splitParticipantId, amountPaise: r.amountPaise })));
    }
    if (!checked.ok) return yield* new LedgerError(checked);
    if (mode === "append" && !checked.allocations.length) return yield* new LedgerError({ code: "no_open_shares", message: `No open shares for ${selection.kind === "oldest_first" ? selection.personName : "this person"}.` });
    // Replace retains the app's row shape (including repeated rows); append
    // inserts only the new, validated allocations and leaves prior row ids intact.
    const allocations = mode === "replace" && selection.kind === "explicit"
      ? selection.rows.filter(r => r.amountPaise > 0)
      : checked.allocations.map(r => ({ splitParticipantId: r.id, amountPaise: r.amountPaise }));
    const allocationsSum = allocations.reduce((n,r) => n + r.amountPaise, 0);
    const inflowAmountPaise = Number(inflow.amountPaise);
    if (mode === "replace") yield* ledgerQuery(() => tx.delete(schema.settlements).where(and(eq(schema.settlements.inflowTransactionId, inflow.id), isNull(schema.settlements.netEventId))));
    if (allocations.length) yield* ledgerQuery(() => tx.insert(schema.settlements).values(allocations.map(a => ({ ...a, inflowTransactionId: inflow.id, method: "bank" as const }))));
    if (mode === "replace") {
      // Clear any previous disposition first so re-saving is idempotent and
      // switching your answer (e.g. "kept" -> "owed back") doesn't leave a
      // stale owed_expense or acknowledgement behind.
      yield* ledgerQuery(() => tx
        .delete(schema.owedExpenses)
        .where(eq(schema.owedExpenses.sourceInflowTransactionId, input.inflowTransactionId)));
      yield* ledgerQuery(() => tx
        .update(schema.transactions)
        .set({ residualDisposition: null, residualAcknowledgedPaise: null })
        .where(eq(schema.transactions.id, input.inflowTransactionId)));

      const residual = input.residual;
      const residualPaise = inflowAmountPaise - reservedByNetSettlePaise - allocationsSum;
      if (residual && residualPaise > 0) {
        if (residual.kind === "owed_back") {
          const personName = residual.personName?.trim();
          if (!personName) {
            return yield* new LedgerError({ code: "invalid_input", message: "A person name is required to record an overpayment as owed back." });
          }
          const personId = yield* ledgerQuery(() => helpers.getOrCreatePerson(user.id, personName, tx));
          yield* ledgerQuery(() => tx.insert(schema.owedExpenses).values({
            userId: user.id,
            personId,
            personName,
            incurredDate: inflow.txnDate,
            amountPaise: residualPaise,
            description: `Overpayment from ${personName}`,
            note: residual.note ?? null,
            sourceInflowTransactionId: input.inflowTransactionId,
          }));
        } else {
          const disposition = residual.kind;
          yield* ledgerQuery(() => tx
            .update(schema.transactions)
            .set({
              residualDisposition: disposition,
              residualAcknowledgedPaise: residualPaise,
            })
            .where(eq(schema.transactions.id, input.inflowTransactionId)));
        }
      }
    }
    const unallocated = available - allocationsSum;
    const value = settlementReceipt({ inflowTransactionId: inflow.id, mode, availablePaise: available,
      applied: checked.allocations.map(r => ({ splitParticipantId: r.id, amountPaise: r.amountPaise, leftPaise: r.leftPaise, personName: helpers.before.participants.find(p => p.id === r.id)!.personName })),
      leftover: input.residual && unallocated > 0 ? { kind: input.residual.kind, paise: unallocated } : null });
    return { revalidate: true, value };
  }));
});

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
