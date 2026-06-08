import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { backfillCounterparties } from "@/db/counterparty-backfill";
import { loadTransactionTableContext } from "@/app/(app)/transactions/load-table-context";
import { TransactionTable } from "@/app/(app)/transactions/TransactionTable";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

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
    <>
      <PageHeader
        title="Review queue"
        description="Transactions you flagged to sort out later. Click Review ✓ on a row when done."
      >
        <div className="flex items-center gap-2">
          <Badge tone="warning">{ctx.rows.length} items</Badge>
          <Link href="/transactions">
            <Button variant="outline" size="sm">← All transactions</Button>
          </Link>
        </div>
      </PageHeader>

      <TransactionTable
        {...ctx}
        emptyMessage="Nothing marked for review. On Transactions, click Review on any row to add it here."
      />
    </>
  );
}
