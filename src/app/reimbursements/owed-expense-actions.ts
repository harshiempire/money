"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { getOrCreatePerson } from "@/db/person";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import {
  assertCategoryOwned,
  assertOwedExpenseOwned,
} from "@/lib/auth/ownership";

const safePaise = (n: number): number =>
  Number.isFinite(n) ? Math.round(n) : 0;

const revalidateAll = () => {
  revalidatePath("/reimbursements");
  revalidatePath("/transactions");
  revalidatePath("/people");
  revalidatePath("/spend");
  revalidatePath("/");
};

export async function createOwedExpense(input: {
  personName: string;
  incurredDate: string;
  amountPaise: number;
  description: string;
  categoryId?: string | null;
  note?: string | null;
}) {
  const user = await requireCurrentUserAction();
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

  const [created] = await db
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

  revalidateAll();
  return created.id;
}

export async function updateOwedExpense(input: {
  id: string;
  personName?: string;
  incurredDate?: string;
  amountPaise?: number;
  description?: string;
  categoryId?: string | null;
  note?: string | null;
}) {
  const user = await requireCurrentUserAction();
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
    updates.note = input.note?.trim()
      ? input.note.trim().slice(0, 200)
      : null;
  }

  if (Object.keys(updates).length === 0) return;

  await db
    .update(schema.owedExpenses)
    .set(updates)
    .where(eq(schema.owedExpenses.id, input.id));

  revalidateAll();
}

export async function deleteOwedExpense(input: { id: string }) {
  const user = await requireCurrentUserAction();
  await assertOwedExpenseOwned(user.id, input.id);

  await db
    .delete(schema.owedExpenses)
    .where(eq(schema.owedExpenses.id, input.id));

  revalidateAll();
}
