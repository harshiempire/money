import Link from "next/link";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { formatPaise } from "@/lib/format";
import { listPersonBalances } from "@/lib/people/ledger";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  const user = await requireCurrentUser();
  const balances = await listPersonBalances(user.id);

  return (
    <>
      <PageHeader
        title="People"
        description="All-time balances across receivables and payables. Not limited to a statement period."
      />

      {balances.length === 0 ? (
        <EmptyState
          title="No open balances"
          description="When you split expenses or record payables, balances with people will appear here."
        />
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)]">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-overlay)] text-left text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                <th className="px-4 py-3">Person</th>
                <th className="px-4 py-3 text-right">They owe me</th>
                <th className="px-4 py-3 text-right">I owe them</th>
                <th className="px-4 py-3 text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((p) => (
                <tr
                  key={p.personId}
                  className="border-t border-[var(--color-border)] bg-[var(--color-surface-raised)] transition-colors hover:bg-[var(--color-surface-overlay)]/50"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/people/${encodeURIComponent(p.personId)}`}
                      className="font-medium text-[var(--color-text)] hover:text-[var(--color-accent)]"
                    >
                      {p.personName}
                    </Link>
                    <div className="text-[10px] text-[var(--color-text-muted)]">
                      {p.openReceivableCount} receivable
                      {p.openReceivableCount === 1 ? "" : "s"} ·{" "}
                      {p.openPayableCount} payable
                      {p.openPayableCount === 1 ? "" : "s"}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Money paise={p.receivableOutstandingPaise} size="sm" className="text-[var(--color-warning)]" />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Money paise={p.payableOutstandingPaise} size="sm" className="text-[var(--color-info)]" />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Money
                      paise={p.netPaise}
                      signed
                      size="sm"
                      className={p.netPaise >= 0 ? "text-[var(--color-warning)]" : "text-[var(--color-info)]"}
                    />
                    {p.netPaise < 0 && (
                      <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">you owe</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
