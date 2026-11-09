import "server-only";
import { DateTime, Effect } from "effect";
import { Actor } from "./services";
import { indiaTodayIso } from "@/lib/dates/india";
import { outstandingPaise } from "./rules/balances";
import { inflowExplanation } from "./rules/settlement-policy";
import { netSettlementDate, netSettlementReceipt, type NetSettlementReceipt } from "./rules/net-settlement";
import { eq, or, type SQL } from "drizzle-orm";
import { ForbiddenError } from "@/lib/auth/forbidden";
import { validateNetEventInvariant } from "@/lib/net-events/validate";
import { schema } from "@/db";
import { LedgerError, type LedgerErrorCode, type WriteContext } from "./context";
import type { LedgerTx } from "./store";
import { runRelationalChange, runRelationalChangeEffect, ledgerQuery, type RelationalHelpers } from "./relational-store";
import type { NetEventLeg } from "@/lib/net-events/legs";
export type { NetEventLeg, NewPayableSpec } from "@/lib/net-events/legs";

const safePaise = (n: number, fallback = 0): number => (Number.isFinite(n) ? Math.round(n) : fallback);
async function fetchTransactionAmount(
  db: LedgerTx,
  helpers: RelationalHelpers,
  userId: string,
  transactionId: string,
  direction: "credit" | "debit",
): Promise<number> {
  await helpers.assertTransactionOwned(userId, transactionId);
  const [row] = await db
    .select({ amountPaise: schema.transactions.amountPaise, direction: schema.transactions.drCr })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, transactionId))
    .limit(1);
  if (!row) {
    throw new LedgerError({ code: "invalid_input", message: "Transaction not found" });
  }
  if (row.direction !== direction) throw new LedgerError({ code: "invalid_input", message: "The bank payment has the wrong direction. Refresh and choose another payment." });
  return Number(row.amountPaise);
}
export const saveNetEvent = Effect.fn("saveNetEvent")(function* (
  ctx: WriteContext,
  input: {
    netEventId?: string;
    eventDate?: string;
    inflowTransactionId?: string;
    outflowTransactionId?: string;
    note?: string;
    legs: NetEventLeg[];
  },
) {
  const actor = yield* Actor;
  ctx = { ...ctx, actor };

  const cleanLegs = input.legs
    .map((leg) => ({
      ...leg,
      amountPaise: safePaise(leg.amountPaise),
    }))
    .filter((leg) => leg.amountPaise > 0);

  if (cleanLegs.length === 0) {
    return yield* new LedgerError({ code: "invalid_input", message: "At least one non-zero leg is required" });
  }

  const hasCash = cleanLegs.some(l => l.method === "cash");
  if (hasCash && (input.inflowTransactionId || input.outflowTransactionId)) return yield* new LedgerError({ code: "invalid_input", message: "Cash settlements cannot also use a bank payment." });
  const now = yield* DateTime.nowAsDate;
  const date = netSettlementDate(hasCash, input.eventDate, indiaTodayIso(now));
  if (!date.ok) return yield* new LedgerError(date);
  for (const leg of cleanLegs) {
    if (leg.kind === "receivable") {
      if (leg.method === "bank" && !input.inflowTransactionId) {
        return yield* new LedgerError({ code: "invalid_input", message: "Bank receivable legs require an inflow transaction" });
      }
    } else if (leg.owedExpenseId && leg.newPayable) {
      return yield* new LedgerError({ code: "invalid_input", message: "A payable leg must either use an existing payable or create a new one, not both" });
    } else if (leg.owedExpenseId) {
      if (leg.method !== "offset" && leg.method !== "cash") {
        return yield* new LedgerError({ code: "invalid_input", message: "Payable legs must use offset or cash method" });
      }
    } else if (leg.newPayable) {
      if (leg.method !== "offset" && leg.method !== "cash") {
        return yield* new LedgerError({ code: "invalid_input", message: "Payable legs must use offset or cash method" });
      }
      const description = leg.newPayable.description.trim();
      if (!description) {
        return yield* new LedgerError({ code: "invalid_input", message: "New payable description is required" });
      }
      if (leg.newPayable.amountPaise <= 0) {
        return yield* new LedgerError({ code: "invalid_input", message: "New payable amount must be positive" });
      }
      if (leg.amountPaise > leg.newPayable.amountPaise) {
        return yield* new LedgerError({ code: "invalid_input", message: `Payable leg exceeds new expense amount by ${(leg.amountPaise - leg.newPayable.amountPaise) / 100}` });
      }
    } else {
      return yield* new LedgerError({ code: "invalid_input", message: "Payable leg requires owedExpenseId or newPayable" });
    }
  }

  return yield* runRelationalChangeEffect(ctx, "save_net_event", (tx, helpers) => Effect.gen(function* () {
    const receiptLegs: Array<NetSettlementReceipt['legs'][number] & { outstandingPaise: number }> = [];
    const user = { id: ctx.actor.userId };
    const {
      assertTransactionOwned,
      assertSplitParticipantOwned,
      assertOwedExpenseOwned,
      assertCategoryOwned,
      assertNetEventOwned,
      getOrCreatePerson,

    } = helpers;

    const ownershipChecks: Promise<unknown>[] = [];
    if (input.inflowTransactionId) {
      ownershipChecks.push(assertTransactionOwned(user.id, input.inflowTransactionId));
    }
    if (input.outflowTransactionId) {
      ownershipChecks.push(assertTransactionOwned(user.id, input.outflowTransactionId));
    }
    if (input.netEventId) {
      ownershipChecks.push(assertNetEventOwned(user.id, input.netEventId));
    }
    for (const leg of cleanLegs) {
      if (leg.kind === "receivable") {
        ownershipChecks.push(assertSplitParticipantOwned(user.id, leg.splitParticipantId));
      } else if (leg.owedExpenseId) {
        ownershipChecks.push(assertOwedExpenseOwned(user.id, leg.owedExpenseId));
      } else if (leg.newPayable?.categoryId) {
        ownershipChecks.push(assertCategoryOwned(user.id, leg.newPayable.categoryId));
      }
    }
    yield* ledgerQuery(() => Promise.all(ownershipChecks));

    // A new event on a transaction that already has one would spend its bank
    // amount twice. Editing goes through netEventId; this only guards creation
    // (e.g. a stale assistant card, or a double-submitted form).
    if (!input.netEventId) {
      const linked: SQL[] = [];
      if (input.inflowTransactionId) {
        linked.push(eq(schema.netEvents.inflowTransactionId, input.inflowTransactionId));
      }
      if (input.outflowTransactionId) {
        linked.push(eq(schema.netEvents.outflowTransactionId, input.outflowTransactionId));
      }
      if (linked.length > 0) {
        const [existing] = yield* ledgerQuery(() => tx
          .select({ id: schema.netEvents.id })
          .from(schema.netEvents)
          .where(or(...linked))
          .limit(1));
        if (existing) {
          return yield* new LedgerError({ code: "invalid_input", message: "This transaction is already net settled. Open Net ✓ to change it." });
        }
      }
    }

    const [inflowAmount, outflowAmount] = yield* ledgerQuery(() => Promise.all([
      input.inflowTransactionId
        ? fetchTransactionAmount(tx, helpers, user.id, input.inflowTransactionId, "credit")
        : Promise.resolve(0),
      input.outflowTransactionId
        ? fetchTransactionAmount(tx, helpers, user.id, input.outflowTransactionId, "debit")
        : Promise.resolve(0),
    ]));

    if (input.inflowTransactionId) {
      const rows = helpers.before;
      const credit = rows.residuals.find(r => r.id === input.inflowTransactionId)!;
      const otherEvent = rows.events.find(r => r.inflowTransactionId === input.inflowTransactionId && r.id !== input.netEventId);
      const explanation = inflowExplanation({ inflowAmountPaise: inflowAmount,
        allocations: rows.settlements.filter(r => r.inflowTransactionId === input.inflowTransactionId && (!input.netEventId || r.netEventId !== input.netEventId)),
        netReservedPaise: 0, hasNetEvent: !!otherEvent && otherEvent.id !== input.netEventId,
        owedSourced: rows.owed.some(r => r.sourceInflowTransactionId === input.inflowTransactionId),
        residualDisposition: credit.residualDisposition, residualAcknowledgedPaise: credit.residualAcknowledgedPaise });
      if (explanation.allocatedPaise || explanation.hasNetEvent || explanation.owedSourced || explanation.acknowledged)
        return yield* new LedgerError({ code: "stale", message: "This payment is already allocated or explained elsewhere. Refresh and review its settlement first." });
    }
    if (input.outflowTransactionId && helpers.before.splits.some(s => s.transactionId === input.outflowTransactionId))
      return yield* new LedgerError({ code: "invalid_input", message: "This bank payment is already a split bill. Choose a separate settlement payment." });

    const invariant = validateNetEventInvariant(cleanLegs, inflowAmount, outflowAmount);
    if (!invariant.ok) {
      return yield* new LedgerError({ code: "invalid_input", message: invariant.message });
    }

    const currentOutstanding = (leg: NetEventLeg):
      | { ok: true; leftPaise: number }
      | { ok: false; code: LedgerErrorCode; message: string } => {
      const rows = helpers.before;
      const cap = leg.kind === "receivable" ? rows.participants.find(r => r.id === leg.splitParticipantId)!.expectedAmountPaise
        : leg.owedExpenseId ? rows.owed.find(r => r.id === leg.owedExpenseId)!.amountPaise : leg.newPayable!.amountPaise;
      const left = outstandingPaise(cap, rows.settlements.filter(r => (!input.netEventId || r.netEventId !== input.netEventId) && (leg.kind === "receivable" ? r.splitParticipantId === leg.splitParticipantId : !!leg.owedExpenseId && r.owedExpenseId === leg.owedExpenseId)));
      if (left === null) return { ok: false, code: "invalid_amount", message: "Balance exceeds the exact integer paise range." };
      if (leg.expectedOutstandingPaise !== undefined && leg.expectedOutstandingPaise !== left) return { ok: false, code: "stale", message: "A balance changed since you opened this settlement. Refresh and review it again." };
      return { ok: true, leftPaise: left };
    };
    // A share can have both bank and offset legs. Cap their combined amount.
    const totals = new Map<string, { leg: NetEventLeg; amountPaise: number }>();
    for (const leg of cleanLegs) {
      const id = leg.kind === "receivable" ? `share:${leg.splitParticipantId}` : leg.owedExpenseId ? `owed:${leg.owedExpenseId}` : undefined;
      if (id) {
        const previous = totals.get(id);
        if (previous && previous.leg.expectedOutstandingPaise !== leg.expectedOutstandingPaise) return yield* new LedgerError({ code: "invalid_input", message: "Conflicting balance previews for the same bill." });
        totals.set(id, { leg, amountPaise: (previous?.amountPaise ?? 0) + leg.amountPaise });
      }
    }
    const capacities = new Map<NetEventLeg, number>();
    for (const leg of cleanLegs) {
      const result = currentOutstanding(leg);
      if (!result.ok) return yield* new LedgerError(result);
      capacities.set(leg, result.leftPaise);
    }
    for (const { leg, amountPaise } of totals.values()) {
      const outstanding = capacities.get(leg)!;
      if (amountPaise > outstanding) return yield* new LedgerError({ code: "invalid_input", message: `Combined ${leg.kind} legs exceed outstanding by ${(amountPaise - outstanding) / 100}` });
    }

    let savedEventId = "";
    if (input.netEventId) {
      yield* ledgerQuery(() => tx.delete(schema.settlements).where(eq(schema.settlements.netEventId, input.netEventId!)));
      yield* ledgerQuery(() => tx.delete(schema.netEvents).where(eq(schema.netEvents.id, input.netEventId!)));
    }

    const [event] = yield* ledgerQuery(() => tx
      .insert(schema.netEvents)
      .values({
        userId: user.id,
        eventDate: date.eventDate,
        inflowTransactionId: input.inflowTransactionId ?? null,
        outflowTransactionId: input.outflowTransactionId ?? null,
        note: input.note?.trim() ? input.note.trim().slice(0, 200) : null,
      })
      .returning({ id: schema.netEvents.id }));
    savedEventId = event.id;

    const settlementRows: Array<typeof schema.settlements.$inferInsert> = [];
    for (const leg of cleanLegs) {
      if (leg.kind === "receivable") {
        receiptLegs.push({ kind: leg.kind, target: { splitParticipantId: leg.splitParticipantId }, method: leg.method, amountPaise: leg.amountPaise, leftPaise: 0, outstandingPaise: capacities.get(leg)! });
        settlementRows.push({
          netEventId: event.id,
          splitParticipantId: leg.splitParticipantId,
          owedExpenseId: null,
          amountPaise: leg.amountPaise,
          method: leg.method,
          inflowTransactionId: leg.method === "bank" ? (input.inflowTransactionId ?? null) : null,
        });
        continue;
      }

      let owedExpenseId = leg.owedExpenseId;
      if (leg.newPayable) {
        const personId = yield* ledgerQuery(() => getOrCreatePerson(user.id, leg.newPayable!.personName, tx));
        const [created] = yield* ledgerQuery(() => tx
          .insert(schema.owedExpenses)
          .values({
            userId: user.id,
            personId,
            personName: leg.newPayable.personName.trim(),
            incurredDate: leg.newPayable.incurredDate,
            amountPaise: leg.newPayable.amountPaise,
            description: leg.newPayable.description.trim(),
            categoryId: leg.newPayable.categoryId ?? null,
            note: leg.newPayable.note?.trim() ? leg.newPayable.note.trim().slice(0, 200) : null,
          })
          .returning({ id: schema.owedExpenses.id }));
        owedExpenseId = created.id;
      }

      receiptLegs.push({ kind: leg.kind, target: { owedExpenseId: owedExpenseId! }, method: leg.method, amountPaise: leg.amountPaise, leftPaise: 0, outstandingPaise: capacities.get(leg)! });
      settlementRows.push({
        netEventId: event.id,
        splitParticipantId: null,
        owedExpenseId,
        amountPaise: leg.amountPaise,
        method: leg.method,
        inflowTransactionId: null,
      });
    }

    yield* ledgerQuery(() => tx.insert(schema.settlements).values(settlementRows));

    return { revalidate: true, value: { netEventId: savedEventId, receipt: netSettlementReceipt({ netEventId: savedEventId, eventDate: date.eventDate, legs: receiptLegs, bankInflowPaise: inflowAmount, bankOutflowPaise: outflowAmount }) } };
  }));
});

export async function deleteNetEvent(ctx: WriteContext, input: { netEventId: string }) {
  try {
    return await runRelationalChange(ctx, "delete_net_event", async (tx, helpers) => {
      const user = { id: ctx.actor.userId };
      const { assertNetEventOwned } = helpers;

      await assertNetEventOwned(user.id, input.netEventId);

      await tx.delete(schema.settlements).where(eq(schema.settlements.netEventId, input.netEventId));
      await tx.delete(schema.netEvents).where(eq(schema.netEvents.id, input.netEventId));

      return { revalidate: true, value: undefined };
    });
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof LedgerError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/timeout|terminat|connect/i.test(msg))
      throw new LedgerError({ code: "unavailable", message: "Database connection timed out while reversing. Please try again." });
    throw err;
  }
}
