"use server";

import { getOrCreateAccountForBank } from "@/db/money-account";
import { categoryTransactions } from "@/domain/spend/net";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";

export async function getCategoryTransactions(input: {
  categoryId: string | null;
  from: string | null;
  to: string | null;
}) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  return categoryTransactions(
    account.id,
    input.from,
    input.to,
    input.categoryId,
    user.id,
  );
}
