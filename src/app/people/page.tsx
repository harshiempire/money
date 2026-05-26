import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { AppNav } from "@/components/AppNav";
import { formatPaise } from "@/lib/format";
import { listPersonBalances } from "@/lib/people/ledger";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  const user = await requireCurrentUser();
  const balances = await listPersonBalances(user.id);

  return (
    <main className="mx-auto max-w-5xl p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">People</h1>
        <AppNav current="/people" />
      </header>

      <p className="mt-1 text-xs text-neutral-500">
        All-time balances across receivables and payables. Not limited to a
        statement period.
      </p>

      {balances.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">
          No open balances with anyone yet.
        </p>
      ) : (
        <table className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-neutral-500">
              <th className="py-2 pr-3">Person</th>
              <th className="py-2 pr-3 text-right">They owe me</th>
              <th className="py-2 pr-3 text-right">I owe them</th>
              <th className="py-2 pr-3 text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {balances.map((p) => (
              <tr
                key={p.personId}
                className="border-t border-neutral-200 dark:border-neutral-800"
              >
                <td className="py-2 pr-3">
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
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-amber-700 dark:text-amber-400">
                  {formatPaise(p.receivableOutstandingPaise)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-sky-700 dark:text-sky-400">
                  {formatPaise(p.payableOutstandingPaise)}
                </td>
                <td
                  className={`py-2 pr-3 text-right font-mono text-sm ${
                    p.netPaise >= 0
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-sky-700 dark:text-sky-400"
                  }`}
                >
                  {formatPaise(Math.abs(p.netPaise))}
                  {p.netPaise < 0 ? " (you owe)" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
