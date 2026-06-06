import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { PageShell } from "@/components/PageShell";
import { Card } from "@/components/ui/Card";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { backfillCounterparties } from "@/db/counterparty-backfill";
import { loadTransactionTableContext } from "@/app/transactions/load-table-context";
import { TransactionTable } from "@/app/transactions/TransactionTable";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const user = await requireCurrentUser();
  const account = await getOrCreateAccountForBank(user.id, "bob");

  await ensureDefaultCategories(user.id);
  await backfillCounterparties(account.id, user.id);

  const where = and(
    eq(schema.transactions.accountId, account.id),
    eq(schema.transactions.needsReview, true),
  );

  const ctx = await loadTransactionTableContext(account.id, user.id, where);

  return (
    <PageShell
      title="Review later"
      width="6xl"
      description={
        <>
          Transactions you flagged to sort out later. Use{" "}
          <strong className="font-medium">Review ✓</strong> on a row to remove
          it from this list when done.
        </>
      }
      actions={
        <a
          href="/transactions"
          className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
        >
          ← All transactions
        </a>
      }
    >
      <Card padding="sm" className="mt-4 text-xs text-neutral-500">
        Account: <strong className="font-medium">{account.name}</strong> (
        {account.bank}) · {ctx.rows.length} item
        {ctx.rows.length === 1 ? "" : "s"}
      </Card>

      <div className="mt-6">
        <TransactionTable
          {...ctx}
          emptyMessage="Nothing marked for review. On Transactions, click Review on any row to add it here."
        />
      </div>
    </PageShell>
  );
}
