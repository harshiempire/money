import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { PageShell } from "@/components/PageShell";
import {
  DataTable,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from "@/components/ui/DataTable";
import { formatPaise } from "@/lib/format";
import { listPersonBalances } from "@/lib/people/ledger";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  const user = await requireCurrentUser();
  const balances = await listPersonBalances(user.id);

  return (
    <PageShell
      title="People"
      description="All-time balances across receivables and payables. Not limited to a statement period."
    >
      {balances.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">
          No open balances with anyone yet.
        </p>
      ) : (
        <DataTable className="mt-6">
          <DataTableHead>
            <tr>
              <DataTableHeaderCell>Person</DataTableHeaderCell>
              <DataTableHeaderCell align="right">They owe me</DataTableHeaderCell>
              <DataTableHeaderCell align="right">I owe them</DataTableHeaderCell>
              <DataTableHeaderCell align="right">Net</DataTableHeaderCell>
            </tr>
          </DataTableHead>
          <tbody>
            {balances.map((p) => (
              <DataTableRow key={p.personId}>
                <DataTableCell>
                  <a
                    href={`/people/${encodeURIComponent(p.personId)}`}
                    className="font-medium hover:underline"
                  >
                    {p.personName}
                  </a>
                  <div className="text-[10px] text-neutral-500">
                    {p.openReceivableCount} receivable
                    {p.openReceivableCount === 1 ? "" : "s"} ·{" "}
                    {p.openPayableCount} payable
                    {p.openPayableCount === 1 ? "" : "s"}
                  </div>
                </DataTableCell>
                <DataTableCell
                  align="right"
                  className="font-mono text-xs text-receivable"
                >
                  {formatPaise(p.receivableOutstandingPaise)}
                </DataTableCell>
                <DataTableCell
                  align="right"
                  className="font-mono text-xs text-payable"
                >
                  {formatPaise(p.payableOutstandingPaise)}
                </DataTableCell>
                <DataTableCell
                  align="right"
                  className={`font-mono text-sm ${
                    p.netPaise >= 0 ? "text-receivable" : "text-payable"
                  }`}
                >
                  {formatPaise(Math.abs(p.netPaise))}
                  {p.netPaise < 0 ? " (you owe)" : ""}
                </DataTableCell>
              </DataTableRow>
            ))}
          </tbody>
        </DataTable>
      )}
    </PageShell>
  );
}
