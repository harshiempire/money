"use client";

import { useTransition } from "react";
import { formatDate, formatPaise } from "@/lib/format";
import { transactionHref } from "@/lib/transactions/href";
import { undoWriteOff } from "./actions";

export interface ForgivenHistoryItem {
  settlementId: string;
  personId: string | null;
  personName: string;
  amountPaise: number;
  note: string | null;
  /** Already formatted on the server (dd/mm/yyyy, Asia/Kolkata). */
  forgivenOn: string;
  txnId: string;
  txnDate: string;
  txnDescription: string;
}

export function ForgivenHistory({
  items,
}: {
  items: ForgivenHistoryItem[];
}) {
  const [pending, startTransition] = useTransition();
  const grouped = new Map<
    string,
    { personId: string | null; personName: string; items: ForgivenHistoryItem[] }
  >();

  for (const item of items) {
    const key = item.personId ?? `name:${item.personName}`;
    const group = grouped.get(key) ?? {
      personId: item.personId,
      personName: item.personName,
      items: [],
    };
    group.items.push(item);
    grouped.set(key, group);
  }

  const undo = (item: ForgivenHistoryItem) => {
    const ok = window.confirm(
      `Undo the ${formatPaise(item.amountPaise)} forgiveness for ${item.personName}? The amount will become outstanding again.`,
    );
    if (!ok) return;
    startTransition(async () => {
      try {
        await undoWriteOff({ settlementId: item.settlementId });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to undo forgiveness";
        console.error("[undoWriteOff]", error);
        window.alert(message);
      }
    });
  };

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">Forgiven history</h2>
      <p className="mt-1 text-xs text-neutral-500">
        All-time amounts you deliberately stopped expecting, grouped by person.
      </p>

      {items.length === 0 ? (
        <p className="mt-3 rounded border border-dashed border-neutral-300 px-3 py-4 text-sm text-neutral-500 dark:border-neutral-700">
          Nothing forgiven yet.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {[...grouped.entries()].map(([key, group]) => {
            const totalPaise = group.items.reduce(
              (sum, item) => sum + item.amountPaise,
              0,
            );
            return (
              <details
                key={key}
                className="rounded border border-neutral-200 dark:border-neutral-800"
              >
                <summary className="cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden">
                  <div className="flex items-baseline justify-between gap-3">
                    <div>
                      <span className="font-medium">{group.personName}</span>
                      <span className="ml-2 text-xs text-neutral-500">
                        {group.items.length} item
                        {group.items.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <span className="font-mono text-sm text-amber-800 dark:text-amber-400">
                      {formatPaise(totalPaise)}
                    </span>
                  </div>
                </summary>
                <ul className="border-t border-neutral-200 dark:border-neutral-800">
                  {group.items.map((item) => (
                    <li
                      key={item.settlementId}
                      className="flex flex-wrap items-start justify-between gap-3 px-3 py-3 text-sm [&:not(:last-child)]:border-b [&:not(:last-child)]:border-neutral-200 dark:[&:not(:last-child)]:border-neutral-800"
                    >
                      <div className="min-w-0">
                        <div className="font-medium">
                          {formatPaise(item.amountPaise)} forgiven
                        </div>
                        <div className="mt-0.5 text-xs text-neutral-500">
                          {formatDate(item.txnDate)} · {item.txnDescription}
                        </div>
                        <div className="mt-0.5 text-[10px] text-neutral-500">
                          Recorded {item.forgivenOn}
                        </div>
                        {item.note && (
                          <div className="mt-1 text-xs italic text-neutral-700 dark:text-neutral-300">
                            “{item.note}”
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-xs">
                        {group.personId && (
                          <a
                            href={`/people/${encodeURIComponent(group.personId)}`}
                            className="underline-offset-2 hover:underline"
                          >
                            View person
                          </a>
                        )}
                        <a
                          href={transactionHref(item.txnId)}
                          className="underline-offset-2 hover:underline"
                        >
                          View transaction
                        </a>
                        <button
                          type="button"
                          onClick={() => undo(item)}
                          disabled={pending}
                          className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400"
                        >
                          Undo
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}
