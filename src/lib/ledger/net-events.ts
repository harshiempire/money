import "server-only";
import { eq, or, type SQL } from "drizzle-orm";
import { NetEventValidationError } from "@/lib/net-events/errors";
import { validateNetEventInvariant } from "@/lib/net-events/validate";
import { schema } from "@/db";
import type { WriteContext } from "./context";
import type { LedgerTx } from "./store";
import { runRelationalChange, type RelationalHelpers } from "./relational-store";
export type NewPayableSpec = {
  personName: string;
  incurredDate: string;
  amountPaise: number;
  description: string;
  categoryId?: string | null;
  note?: string | null;
};

export type NetEventLeg =
  | {
      kind: "receivable";
      splitParticipantId: string;
      amountPaise: number;
      method: "bank" | "offset";
    }
  | ({
      kind: "payable";
      amountPaise: number;
      method: "offset";
    } & (
      { owedExpenseId: string; newPayable?: never } | { owedExpenseId?: never; newPayable: NewPayableSpec }
    ));

const safePaise = (n: number, fallback = 0): number => (Number.isFinite(n) ? Math.round(n) : fallback);
async function fetchTransactionAmount(
  db: LedgerTx,
  helpers: RelationalHelpers,
  userId: string,
  transactionId: string,
): Promise<number> {
  await helpers.assertTransactionOwned(userId, transactionId);
  const [row] = await db
    .select({ amountPaise: schema.transactions.amountPaise })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, transactionId))
    .limit(1);
  if (!row) {
    throw new NetEventValidationError("MISSING_BANK_TXN", "Transaction not found");
  }
  return Number(row.amountPaise);
}
export async function saveNetEvent(
  ctx: WriteContext,
  input: {
    netEventId?: string;
    eventDate: string;
    inflowTransactionId?: string;
    outflowTransactionId?: string;
    note?: string;
    legs: NetEventLeg[];
  },
) {
  try {
    return await runRelationalChange(ctx, "save_net_event", async (tx, helpers) => {
      const user = { id: ctx.actor.userId };
      const {
        assertTransactionOwned,
        assertSplitParticipantOwned,
        assertOwedExpenseOwned,
        assertCategoryOwned,
        assertNetEventOwned,
        getOrCreatePerson,
        participantOutstanding,
        owedExpenseOutstanding,
      } = helpers;

      const cleanLegs = input.legs
        .map((leg) => ({
          ...leg,
          amountPaise: safePaise(leg.amountPaise),
        }))
        .filter((leg) => leg.amountPaise > 0);

      if (cleanLegs.length === 0) {
        throw new NetEventValidationError("INVALID_LEG", "At least one non-zero leg is required");
      }

      for (const leg of cleanLegs) {
        if (leg.kind === "receivable") {
          if (leg.method === "bank" && !input.inflowTransactionId) {
            throw new NetEventValidationError(
              "MISSING_BANK_TXN",
              "Bank receivable legs require an inflow transaction",
            );
          }
        } else if (leg.owedExpenseId) {
          if (leg.method !== "offset") {
            throw new NetEventValidationError("INVALID_LEG", "Payable legs must use offset method");
          }
        } else if (leg.newPayable) {
          if (leg.method !== "offset") {
            throw new NetEventValidationError("INVALID_LEG", "Payable legs must use offset method");
          }
          const description = leg.newPayable.description.trim();
          if (!description) {
            throw new NetEventValidationError("INVALID_LEG", "New payable description is required");
          }
          if (leg.newPayable.amountPaise <= 0) {
            throw new NetEventValidationError("INVALID_LEG", "New payable amount must be positive");
          }
          if (leg.amountPaise > leg.newPayable.amountPaise) {
            throw new NetEventValidationError(
              "OVER_ALLOCATION",
              `Payable leg exceeds new expense amount by ${(leg.amountPaise - leg.newPayable.amountPaise) / 100}`,
            );
          }
        } else {
          throw new NetEventValidationError(
            "INVALID_LEG",
            "Payable leg requires owedExpenseId or newPayable",
          );
        }
      }

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
      await Promise.all(ownershipChecks);

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
          const [existing] = await tx
            .select({ id: schema.netEvents.id })
            .from(schema.netEvents)
            .where(or(...linked))
            .limit(1);
          if (existing) {
            throw new NetEventValidationError(
              "INVALID_LEG",
              "This transaction is already net settled. Open Net ✓ to change it.",
            );
          }
        }
      }

      const [inflowAmount, outflowAmount] = await Promise.all([
        input.inflowTransactionId
          ? fetchTransactionAmount(tx, helpers, user.id, input.inflowTransactionId)
          : Promise.resolve(0),
        input.outflowTransactionId
          ? fetchTransactionAmount(tx, helpers, user.id, input.outflowTransactionId)
          : Promise.resolve(0),
      ]);

      const invariant = validateNetEventInvariant(cleanLegs, inflowAmount, outflowAmount);
      if (!invariant.ok) {
        throw new NetEventValidationError("INVARIANT_MISMATCH", invariant.message);
      }

      // A share can have both bank and offset legs. Cap their combined amount.
      const totals = new Map<string, { leg: NetEventLeg; amountPaise: number }>();
      for (const leg of cleanLegs) {
        const id = leg.kind === "receivable" ? `share:${leg.splitParticipantId}` : leg.owedExpenseId ? `owed:${leg.owedExpenseId}` : undefined;
        if (id) totals.set(id, { leg, amountPaise: (totals.get(id)?.amountPaise ?? 0) + leg.amountPaise });
      }
      await Promise.all(
        [...totals.values()].map(async ({ leg, amountPaise }) => {
          if (leg.kind === "receivable") {
            const outstanding = await participantOutstanding(leg.splitParticipantId, input.netEventId);
            if (amountPaise > outstanding) {
              throw new NetEventValidationError(
                "OVER_ALLOCATION",
                `Combined receivable legs exceed outstanding by ${(amountPaise - outstanding) / 100}`,
              );
            }
          } else if (leg.owedExpenseId) {
            const outstanding = await owedExpenseOutstanding(leg.owedExpenseId, input.netEventId);
            if (amountPaise > outstanding) {
              throw new NetEventValidationError(
                "OVER_ALLOCATION",
                `Combined payable legs exceed outstanding by ${(amountPaise - outstanding) / 100}`,
              );
            }
          }
        }),
      );

      let savedEventId = "";
      if (input.netEventId) {
        await tx.delete(schema.settlements).where(eq(schema.settlements.netEventId, input.netEventId));
        await tx.delete(schema.netEvents).where(eq(schema.netEvents.id, input.netEventId));
      }

      const [event] = await tx
        .insert(schema.netEvents)
        .values({
          userId: user.id,
          eventDate: input.eventDate,
          inflowTransactionId: input.inflowTransactionId ?? null,
          outflowTransactionId: input.outflowTransactionId ?? null,
          note: input.note?.trim() ? input.note.trim().slice(0, 200) : null,
        })
        .returning({ id: schema.netEvents.id });
      savedEventId = event.id;

      const settlementRows = [];
      for (const leg of cleanLegs) {
        if (leg.kind === "receivable") {
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
          const personId = await getOrCreatePerson(user.id, leg.newPayable.personName, tx);
          const [created] = await tx
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
            .returning({ id: schema.owedExpenses.id });
          owedExpenseId = created.id;
        }

        settlementRows.push({
          netEventId: event.id,
          splitParticipantId: null,
          owedExpenseId,
          amountPaise: leg.amountPaise,
          method: "offset" as const,
          inflowTransactionId: null,
        });
      }

      await tx.insert(schema.settlements).values(settlementRows);

      return { revalidate: true, value: { netEventId: savedEventId } };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/timeout|terminat|connect/i.test(msg))
      throw new Error("Database connection timed out while saving. Please try again in a moment.");
    throw err;
  }
}

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
    const msg = err instanceof Error ? err.message : String(err);
    if (/timeout|terminat|connect/i.test(msg))
      throw new Error("Database connection timed out while reversing. Please try again.");
    throw err;
  }
}
