import "server-only";
import { eq } from "drizzle-orm";
import { schema } from "@/db";
import { LedgerError, type WriteContext } from "./context";
import { sourceInflowCapacity } from "./owed-capacity";
import type { LedgerTx } from "./store";
import { runRelationalChange, type RelationalHelpers } from "./relational-store";

const safePaise = (n: number, fallback = 0): number => (Number.isFinite(n) ? Math.round(n) : fallback);

/** Called only with the actor snapshot and bank rows locked by runRelationalChange. */
async function assertSourceCapacity(tx: LedgerTx, helpers: RelationalHelpers, ctx: WriteContext,
  sourceId: string, amountPaise: number, excludeOwedId?: string) {
  await helpers.assertTransactionOwned(ctx.actor.userId, sourceId);
  const [inflow] = await tx.select().from(schema.transactions).where(eq(schema.transactions.id, sourceId));
  if (inflow.drCr !== "credit") throw new LedgerError({ code: "invalid_input", message: "A source inflow must be a credit." });
  const capacity = sourceInflowCapacity({ amountPaise: inflow.amountPaise,
    allocatedPaise: helpers.before.settlements.filter(row => row.inflowTransactionId === sourceId).reduce((sum, row) => sum + row.amountPaise, 0),
    hasOtherPayable: helpers.before.owed.some(row => row.sourceInflowTransactionId === sourceId && row.id !== excludeOwedId),
    residualDisposition: inflow.residualDisposition });
  if (amountPaise > capacity)
    throw new LedgerError({ code: "invalid_input", message: "Source inflow is already explained or has insufficient unallocated money." });
  const [net] = await tx.select({ id: schema.netEvents.id }).from(schema.netEvents).where(eq(schema.netEvents.inflowTransactionId, sourceId));
  if (net) throw new LedgerError({ code: "invalid_input", message: "Source inflow is part of a net event." });
}

export async function createOwedExpense(
  ctx: WriteContext,
  input: {
    personName: string;
    incurredDate: string;
    amountPaise: number;
    description: string;
    categoryId?: string | null;
    note?: string | null;
    sourceInflowTransactionId?: string;
  },
) {
  return runRelationalChange(ctx, "create_owed_expense", async (tx, helpers) => {
    const user = { id: ctx.actor.userId };
    const { assertCategoryOwned, getOrCreatePerson } = helpers;

    const amountPaise = safePaise(input.amountPaise);
    if (amountPaise <= 0) {
      throw new LedgerError({ code: "invalid_input", message: "Amount must be positive" });
    }

    const description = input.description.trim();
    if (!description) {
      throw new LedgerError({ code: "invalid_input", message: "Description is required" });
    }

    if (input.categoryId) {
      await assertCategoryOwned(user.id, input.categoryId);
    }

    if (input.sourceInflowTransactionId) {
      await assertSourceCapacity(tx, helpers, ctx, input.sourceInflowTransactionId, amountPaise);
    }

    const personId = await getOrCreatePerson(user.id, input.personName);

    const [created] = await tx
      .insert(schema.owedExpenses)
      .values({
        userId: user.id,
        personId,
        personName: input.personName.trim(),
        incurredDate: input.incurredDate,
        amountPaise,
        description,
        categoryId: input.categoryId ?? null,
        note: input.note?.trim() ? input.note.trim().slice(0, 200) : null,
        sourceInflowTransactionId: input.sourceInflowTransactionId ?? null,
      })
      .returning({ id: schema.owedExpenses.id });

    return { revalidate: true, value: created.id };
  });
}

export async function updateOwedExpense(
  ctx: WriteContext,
  input: {
    id: string;
    personName?: string;
    incurredDate?: string;
    amountPaise?: number;
    description?: string;
    categoryId?: string | null;
    note?: string | null;
  },
) {
  return runRelationalChange(ctx, "update_owed_expense", async (tx, helpers) => {
    const user = { id: ctx.actor.userId };
    const { assertOwedExpenseOwned, assertCategoryOwned, getOrCreatePerson } = helpers;

    await assertOwedExpenseOwned(user.id, input.id);

    const updates: Partial<typeof schema.owedExpenses.$inferInsert> = {};

    if (input.personName !== undefined) {
      const personId = await getOrCreatePerson(user.id, input.personName);
      updates.personId = personId;
      updates.personName = input.personName.trim();
    }
    if (input.incurredDate !== undefined) {
      updates.incurredDate = input.incurredDate;
    }
    if (input.amountPaise !== undefined) {
      const amountPaise = safePaise(input.amountPaise);
      if (amountPaise <= 0) throw new LedgerError({ code: "invalid_input", message: "Amount must be positive" });
      const settled = (await helpers.settledAmountByOwedExpenseIds([input.id])).get(input.id) ?? 0;
      if (amountPaise < settled)
        throw new LedgerError({ code: "invalid_input", message: `Amount cannot be less than the existing settlements of ₹${(settled / 100).toFixed(2)}.` });
      const current = helpers.before.owed.find(row => row.id === input.id)!;
      if (current.sourceInflowTransactionId && amountPaise !== current.amountPaise)
        await assertSourceCapacity(tx, helpers, ctx, current.sourceInflowTransactionId, amountPaise, current.id);
      updates.amountPaise = amountPaise;
    }
    if (input.description !== undefined) {
      const description = input.description.trim();
      if (!description) throw new LedgerError({ code: "invalid_input", message: "Description is required" });
      updates.description = description;
    }
    if (input.categoryId !== undefined) {
      if (input.categoryId) {
        await assertCategoryOwned(user.id, input.categoryId);
      }
      updates.categoryId = input.categoryId;
    }
    if (input.note !== undefined) {
      updates.note = input.note?.trim() ? input.note.trim().slice(0, 200) : null;
    }

    if (Object.keys(updates).length === 0) return { revalidate: false, value: undefined };

    await tx.update(schema.owedExpenses).set(updates).where(eq(schema.owedExpenses.id, input.id));

    return { revalidate: true, value: undefined };
  });
}

export async function deleteOwedExpense(ctx: WriteContext, input: { id: string }) {
  return runRelationalChange(ctx, "delete_owed_expense", async (tx, helpers) => {
    const user = { id: ctx.actor.userId };
    const { assertOwedExpenseOwned } = helpers;

    await assertOwedExpenseOwned(user.id, input.id);

    await tx.delete(schema.owedExpenses).where(eq(schema.owedExpenses.id, input.id));

    return { revalidate: true, value: undefined };
  });
}
