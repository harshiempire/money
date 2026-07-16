import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import {
  ensureTenantDefaults,
  getBobAccount,
  getCurrentUser,
  runCounterpartyBackfill,
} from "@/lib/auth/request-tenant";
import { AppShell } from "@/components/AppShell";
import { loadTransactionTableContext } from "@/app/transactions/load-table-context";
import { TransactionTable } from "@/app/transactions/TransactionTable";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const user = await getCurrentUser();
  const account = await getBobAccount();

  await ensureTenantDefaults();
  await runCounterpartyBackfill();

  const where = and(
    eq(schema.transactions.accountId, account.id),
    eq(schema.transactions.needsReview, true),
  );

  const ctx = await loadTransactionTableContext(account.id, user.id, where);

  return (
    <AppShell title="Review later" width="wide">
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        Transactions you flagged to sort out later. Use{" "}
        <strong className="font-normal">Review ✓</strong> on a row to remove it
        from this list when done.
      </p>
      <p className="mt-1 text-xs text-neutral-500">
        Account: <strong>{account.name}</strong> ({account.bank}) ·{" "}
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
