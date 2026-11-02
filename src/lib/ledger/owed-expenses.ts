import "server-only";
import { eq } from "drizzle-orm";
import { schema } from "@/db";
import type { WriteContext } from "./context";
import { runRelationalChange } from "./relational-store";

const safePaise = (n: number, fallback = 0): number => (Number.isFinite(n) ? Math.round(n) : fallback);

export async function createOwedExpense(
  ctx: WriteContext,
  input: {
    personName: string;
    incurredDate: string;
    amountPaise: number;
    description: string;
    categoryId?: string | null;
    note?: string | null;
  },
) {
  return runRelationalChange(ctx, "create_owed_expense", async (tx, helpers) => {
    const user = { id: ctx.actor.userId };
    const { assertCategoryOwned, getOrCreatePerson } = helpers;

    const amountPaise = safePaise(input.amountPaise);
    if (amountPaise <= 0) {
      throw new Error("Amount must be positive");
    }

    const description = input.description.trim();
    if (!description) {
      throw new Error("Description is required");
    }

    if (input.categoryId) {
      await assertCategoryOwned(user.id, input.categoryId);
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
      if (amountPaise <= 0) throw new Error("Amount must be positive");
      updates.amountPaise = amountPaise;
    }
    if (input.description !== undefined) {
      const description = input.description.trim();
      if (!description) throw new Error("Description is required");
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
