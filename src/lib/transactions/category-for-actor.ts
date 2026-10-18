import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { assertCategoryOwned, assertTransactionOwned } from "@/lib/auth/ownership";

export async function categoryIsTransfer(categoryId: string, userId: string): Promise<boolean> {
  const [cat] = await db
    .select({ kind: schema.categories.kind })
    .from(schema.categories)
    .where(and(eq(schema.categories.id, categoryId), eq(schema.categories.userId, userId)))
    .limit(1);
  return cat?.kind === "transfer" || cat?.kind === "investment";
}

/**
 * The category write `setTransactionCategory` uses after it has authenticated.
 * `accountId`, when present, must be the account the caller is acting for.
 */
export async function setCategoryForActor(
  actor: { userId: string; accountId?: string },
  input: {
    transactionId: string;
    categoryId: string;
    expectedCurrentCategoryId?: string | null;
  },
): Promise<void> {
  const { accountId } = await assertTransactionOwned(actor.userId, input.transactionId);
  if (actor.accountId && actor.accountId !== accountId) {
    throw new Error("That transaction isn't in this account.");
  }
  if (input.expectedCurrentCategoryId !== undefined) {
    const [current] = await db
      .select({ categoryId: schema.transactions.categoryId })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, input.transactionId))
      .limit(1);
    if ((current?.categoryId ?? null) !== (input.expectedCurrentCategoryId || null)) {
      throw new Error("The category changed since this card was made. Ask again to get a fresh card.");
    }
  }
  const newCategoryId = input.categoryId === "" ? null : input.categoryId;
  if (newCategoryId) await assertCategoryOwned(actor.userId, newCategoryId);
  const isTransfer = newCategoryId ? await categoryIsTransfer(newCategoryId, actor.userId) : false;
  await db
    .update(schema.transactions)
    .set({ categoryId: newCategoryId, isTransfer })
    .where(and(eq(schema.transactions.id, input.transactionId), eq(schema.transactions.accountId, accountId)));
}
