"use server";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { ensureDefaultBobAccount } from "@/db/seed-account";
import { ensureSeedUser } from "@/db/seed-user";
import { detectTransferPairs } from "@/domain/transfers/detect";

/**
 * Set or clear a single transaction's category. Auto-flips `is_transfer` when
 * the chosen category is a transfer- or investment-kind, since those should
 * never count as personal spend in the dashboard.
 *
 * `categoryId` is "" to clear.
 */
export async function setTransactionCategory(input: {
  transactionId: string;
  categoryId: string;
}) {
  const userId = await ensureSeedUser();
  const newCategoryId = input.categoryId === "" ? null : input.categoryId;
  const isTransfer = newCategoryId
    ? await categoryIsTransfer(newCategoryId, userId)
    : false;

  await db
    .update(schema.transactions)
    .set({ categoryId: newCategoryId, isTransfer })
    .where(eq(schema.transactions.id, input.transactionId));

  revalidatePath("/transactions");
  revalidatePath("/");
}

/**
 * Use this row's category as the default for its counterparty, then apply it
 * to every other transaction from that counterparty that still has no
 * category set. The "rule learning" behavior from the plan.
 */
export async function applyCategoryToCounterparty(input: {
  transactionId: string;
}) {
  const userId = await ensureSeedUser();

  const [txn] = await db
    .select({
      counterpartyId: schema.transactions.counterpartyId,
      categoryId: schema.transactions.categoryId,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, input.transactionId))
    .limit(1);
  if (!txn || !txn.counterpartyId || !txn.categoryId) return { updated: 0 };

  const isTransfer = await categoryIsTransfer(txn.categoryId, userId);

  await db
    .update(schema.counterparties)
    .set({ defaultCategoryId: txn.categoryId })
    .where(
      and(
        eq(schema.counterparties.id, txn.counterpartyId),
        eq(schema.counterparties.userId, userId),
      ),
    );

  const updated = await db
    .update(schema.transactions)
    .set({ categoryId: txn.categoryId, isTransfer })
    .where(
      and(
        eq(schema.transactions.counterpartyId, txn.counterpartyId),
        isNull(schema.transactions.categoryId),
      ),
    )
    .returning({ id: schema.transactions.id });

  revalidatePath("/transactions");
  revalidatePath("/");
  return { updated: updated.length };
}

async function categoryIsTransfer(
  categoryId: string,
  userId: string,
): Promise<boolean> {
  const [cat] = await db
    .select({ kind: schema.categories.kind })
    .from(schema.categories)
    .where(
      and(
        eq(schema.categories.id, categoryId),
        eq(schema.categories.userId, userId),
      ),
    )
    .limit(1);
  return cat?.kind === "transfer" || cat?.kind === "investment";
}

export async function setTransactionTransfer(input: {
  transactionId: string;
  isTransfer: boolean;
}) {
  await db
    .update(schema.transactions)
    .set({ isTransfer: input.isTransfer })
    .where(eq(schema.transactions.id, input.transactionId));
  revalidatePath("/transactions");
  revalidatePath("/");
}

export async function setTransactionNote(input: {
  transactionId: string;
  note: string;
}) {
  const cleaned = input.note.trim();
  await db
    .update(schema.transactions)
    .set({ note: cleaned === "" ? null : cleaned })
    .where(eq(schema.transactions.id, input.transactionId));
  revalidatePath("/transactions");
  revalidatePath("/");
}

/**
 * Walk every transaction in the seed account, pair up matching debit/credit
 * (same amount, ±3 days) that aren't yet flagged as transfer, and flip
 * is_transfer=true on both sides. Returns the count of pairs marked.
 */
export async function autoDetectTransfers(): Promise<{ pairs: number }> {
  const account = await ensureDefaultBobAccount();
  const rows = await db
    .select({
      id: schema.transactions.id,
      txnDate: schema.transactions.txnDate,
      amountPaise: schema.transactions.amountPaise,
      drCr: schema.transactions.drCr,
      channel: schema.transactions.channel,
      counterpartyId: schema.transactions.counterpartyId,
      isTransfer: schema.transactions.isTransfer,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.accountId, account.id));

  const pairs = detectTransferPairs(rows);
  if (pairs.length === 0) {
    revalidatePath("/transactions");
    return { pairs: 0 };
  }
  const ids = pairs.flatMap((p) => [p.debitId, p.creditId]);
  await db
    .update(schema.transactions)
    .set({ isTransfer: true })
    .where(inArray(schema.transactions.id, ids));
  revalidatePath("/transactions");
  revalidatePath("/");
  revalidatePath("/timeline");
  return { pairs: pairs.length };
}
