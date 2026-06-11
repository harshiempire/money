import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { AppShell } from "@/components/AppShell";
import { formatPaise } from "@/lib/format";
import { listPersonBalances } from "@/lib/people/ledger";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  const user = await requireCurrentUser();
  const balances = await listPersonBalances(user.id);

  return (
    <AppShell title="People">
      <p className="mt-1 text-xs text-neutral-500">
        All-time balances across receivables and payables. Not limited to a
        statement period.
      </p>

      {balances.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">
          No open balances with anyone yet.
        </p>
      ) : (
        <>
        <table className="mt-6 hidden w-full border-collapse text-sm md:table">
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
                <td className="py-2 pr-3 text-right font-mono text-xs text-owed-to-me">
                  {formatPaise(p.receivableOutstandingPaise)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-i-owe">
                  {formatPaise(p.payableOutstandingPaise)}
                </td>
                <td
                  className={`py-2 pr-3 text-right font-mono text-sm ${
                    p.netPaise >= 0
                      ? "text-owed-to-me"
                      : "text-i-owe"
                  }`}
                >
                  {formatPaise(Math.abs(p.netPaise))}
                  {p.netPaise < 0 ? " (you owe)" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="mt-6 space-y-2 md:hidden">
          {balances.map((p) => (
            <li
              key={p.personId}
              className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
            >
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
              <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <dt className="text-neutral-500">They owe me</dt>
                  <dd className="font-mono text-owed-to-me">
                    {formatPaise(p.receivableOutstandingPaise)}
                  </dd>
                </div>
                <div>
                  <dt className="text-neutral-500">I owe them</dt>
                  <dd className="font-mono text-i-owe">
                    {formatPaise(p.payableOutstandingPaise)}
                  </dd>
                </div>
                <div>
                  <dt className="text-neutral-500">Net</dt>
                  <dd
                    className={`font-mono ${
                      p.netPaise >= 0 ? "text-owed-to-me" : "text-i-owe"
                    }`}
                  >
                    {formatPaise(Math.abs(p.netPaise))}
                    {p.netPaise < 0 ? " (you owe)" : ""}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
        </>
      )}
    </AppShell>
  );
}
