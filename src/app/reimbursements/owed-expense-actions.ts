"use server";
import { revalidatePath } from "next/cache";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import {
  createOwedExpense as createOwedExpenseForActor,
  updateOwedExpense as updateOwedExpenseForActor,
  deleteOwedExpense as deleteOwedExpenseForActor,
} from "@/lib/ledger/owed-expenses";

export async function createOwedExpense(input: {
  personName: string;
  incurredDate: string;
  amountPaise: number;
  description: string;
  categoryId?: string | null;
  note?: string | null;
}) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const result = await createOwedExpenseForActor(
    { actor: { userId: user.id, accountId: account.id }, source: "app" },
    {
      personName: input.personName,
      incurredDate: input.incurredDate,
      amountPaise: input.amountPaise,
      description: input.description,
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    },
  );
  if (result.revalidate) {
    revalidatePath("/reimbursements");
    revalidatePath("/transactions");
    revalidatePath("/people");
    revalidatePath("/spend");
    revalidatePath("/");
  }
  return result.value!;
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
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const result = await updateOwedExpenseForActor(
    { actor: { userId: user.id, accountId: account.id }, source: "app" },
    {
      id: input.id,
      ...(input.personName !== undefined ? { personName: input.personName } : {}),
      ...(input.incurredDate !== undefined ? { incurredDate: input.incurredDate } : {}),
      ...(input.amountPaise !== undefined ? { amountPaise: input.amountPaise } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    },
  );
  if (result.revalidate) {
    revalidatePath("/reimbursements");
    revalidatePath("/transactions");
    revalidatePath("/people");
    revalidatePath("/spend");
    revalidatePath("/");
  }
}

export async function deleteOwedExpense(input: { id: string }) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const result = await deleteOwedExpenseForActor(
    { actor: { userId: user.id, accountId: account.id }, source: "app" },
    {
      id: input.id,
    },
  );
  if (result.revalidate) {
    revalidatePath("/reimbursements");
    revalidatePath("/transactions");
    revalidatePath("/people");
    revalidatePath("/spend");
    revalidatePath("/");
  }
}
