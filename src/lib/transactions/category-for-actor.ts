import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { assertTransactionOwned } from "@/lib/auth/ownership";
import { editTransactionFields } from "@/lib/ledger/transaction-fields";

export async function categoryIsTransfer(categoryId: string, userId: string): Promise<boolean> {
  const [cat] = await db.select({ kind: schema.categories.kind }).from(schema.categories)
    .where(and(eq(schema.categories.id, categoryId), eq(schema.categories.userId, userId))).limit(1);
  return cat?.kind === "transfer" || cat?.kind === "investment";
}
export async function setCategoryForActor(
  actor: { userId: string; accountId?: string },
  input: { transactionId: string; categoryId: string; expectedCurrentCategoryId?: string | null; isTransfer?: boolean },
): Promise<{ previousIsTransfer: boolean }> {
  const accountId = actor.accountId ?? (await assertTransactionOwned(actor.userId, input.transactionId)).accountId;
  const result = await editTransactionFields({ actor: { ...actor, accountId }, source: "app" }, {
    kind: "transaction_fields", edits: [{ transactionId: input.transactionId,
      set: { categoryId: input.categoryId || null, ...(input.isTransfer !== undefined ? { isTransfer: input.isTransfer } : {}) },
      ...(input.expectedCurrentCategoryId !== undefined ? { guard: { categoryId: input.expectedCurrentCategoryId } } : {}),
    }],
  });
  if (result.errors?.length) {
    if (result.errors[0].code === "stale") throw new Error("The category changed since this card was made. Ask again to get a fresh card.");
    throw new Error(result.errors[0].message);
  }
  return { previousIsTransfer: result.rows[0].before.isTransfer };
}
