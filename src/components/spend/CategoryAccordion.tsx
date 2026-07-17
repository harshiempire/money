"use client";

import { useState, useTransition } from "react";
import { counterpartyLabel, formatDate, formatPaise } from "@/lib/format";
import { transactionHref } from "@/lib/transactions/href";
import type { CategoryTransactionRow } from "@/domain/spend/net";
import { getCategoryTransactions } from "@/app/spend/actions";

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
  const [rows, setRows] = useState<CategoryTransactionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const loadOnce = () => {
    if (rows !== null || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        setRows(await getCategoryTransactions({ categoryId, from, to }));
      } catch {
        setError("Could not load transactions for this category.");
      }
    });
  };

  return (
    <details
      className="group rounded border border-neutral-200 dark:border-neutral-800"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) loadOnce();
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
                        <a
                          href={transactionHref(r.id)}
                          className="text-neutral-500 underline-offset-2 hover:underline"
                        >
                          View →
                        </a>
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
