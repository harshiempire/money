import { and, inArray, eq } from "drizzle-orm";
import { schema } from "@/db";
import { getAllAccountsForUser } from "@/db/money-account";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { AppShell } from "@/components/AppShell";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { backfillCounterparties } from "@/db/counterparty-backfill";
import { loadTransactionTableContext } from "@/app/transactions/load-table-context";
import { TransactionTable } from "@/app/transactions/TransactionTable";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const user = await requireCurrentUser();
  const accounts = await getAllAccountsForUser(user.id);
  const accountIds = accounts.map((a) => a.id);

  await ensureDefaultCategories(user.id);
  await backfillCounterparties(accountIds, user.id);

  const where =
    accountIds.length > 0
      ? and(
          inArray(schema.transactions.accountId, accountIds),
          eq(schema.transactions.needsReview, true),
        )
      : and(eq(schema.transactions.needsReview, true));

  const ctx = await loadTransactionTableContext(accountIds, user.id, where);

  return (
    <AppShell title="Review later" width="wide">
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        Transactions you flagged to sort out later. Use{" "}
        <strong className="font-normal">Review ✓</strong> on a row to remove it
        from this list when done.
      </p>
      <p className="mt-1 text-xs text-neutral-500">
        {ctx.rows.length} item{ctx.rows.length === 1 ? "" : "s"}
      </p>

      <p className="mt-4">
        <a
          href="/transactions"
          className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
        >
          ← All transactions
        </a>
      </p>

      <TransactionTable
        {...ctx}
        emptyMessage="Nothing marked for review. On Transactions, click Review on any row to add it here."
      />
    </AppShell>
  );
}
