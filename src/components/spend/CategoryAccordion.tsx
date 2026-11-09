"use client";

import Link from "next/link";
import { useState } from "react";
import { counterpartyLabel, formatDate, formatPaise } from "@/lib/format";
import { transactionHref } from "@/lib/transactions/href";
import { ActionError, callAction, unwrap } from "@/lib/action/result";
import { getCategoryTransactions } from "@/app/spend/actions";

import { useQuery } from "@tanstack/react-query";
import { moneyKeys } from "@/lib/query/keys";
import { useMoneyQueryUser } from "@/lib/query/use-money-query";

export function CategoryAccordion({
  categoryId,
  categoryName,
  netSelfPaise,
  sharePercent,
  from,
  to,
}: {
  categoryId: string | null;
  categoryName: string;
  netSelfPaise: number;
  sharePercent: number | null;
  from: string | null;
  to: string | null;
}) {
  const [open, setOpen] = useState(false);
  const userId = useMoneyQueryUser();
  const query = useQuery({
    queryKey: moneyKeys.category(userId, categoryId, from, to),
    queryFn: async () => unwrap(await callAction(() => getCategoryTransactions({ categoryId, from, to }))),
    enabled: open && !!userId,
  });
  const rows = query.isError ? null : query.data ?? null;
  const error = query.error
    ? query.error instanceof ActionError && query.error.code !== "INTERNAL"
      ? query.error.message : "Could not load transactions for this category."
    : null;
  const pending = query.isPending && open;

  return (
    <details
      className="group rounded border border-neutral-200 dark:border-neutral-800"
      onToggle={(e) => {
        setOpen((e.target as HTMLDetailsElement).open);
      }}
    >
      <summary className="flex cursor-pointer list-none items-baseline justify-between gap-2 px-2 py-1.5 text-sm [&::-webkit-details-marker]:hidden">
        <span className="font-medium">{categoryName}</span>
        <span className="font-mono text-xs whitespace-nowrap">
          {formatPaise(netSelfPaise)}
          {sharePercent != null && (
            <span className="text-neutral-500"> · {sharePercent.toFixed(0)}%</span>
          )}
        </span>
      </summary>

      <div className="border-t border-neutral-200 px-2 py-2 dark:border-neutral-800">
        {pending && !rows && (
          <p className="text-xs text-neutral-500">Loading…</p>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
        {rows && rows.length === 0 && (
          <p className="text-xs text-neutral-500">No transactions found.</p>
        )}
        {rows && rows.length > 0 && (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs"
              >
                <span className="min-w-0">
                  <span className="block">
                    <span className="font-mono text-neutral-500">
                      {formatDate(r.txnDate)}
                    </span>{" "}
                    {r.counterpartyDisplayName ??
                      counterpartyLabel(r.rawDescription)}
                    {r.source === "bank" ? (
                      <>
                        {" "}
                        <Link
                          href={transactionHref(r.id)}
                          className="text-neutral-500 underline-offset-2 hover:underline"
                        >
                          View →
                        </Link>
                      </>
                    ) : (
                      <span className="ml-1 text-neutral-500">
                        (fronted by someone else)
                      </span>
                    )}
                  </span>
                  {(r.parsedPurpose || r.note) && (
                    <span className="mt-0.5 block italic text-neutral-500">
                      {[r.parsedPurpose, r.note].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </span>
                <span className="font-mono whitespace-nowrap">
                  {formatPaise(r.netSelfPaise)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
