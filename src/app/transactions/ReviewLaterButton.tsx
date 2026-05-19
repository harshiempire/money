"use client";

import { useTransition } from "react";
import { setTransactionNeedsReview } from "./actions";

export function ReviewLaterButton({
  transactionId,
  needsReview,
}: {
  transactionId: string;
  needsReview: boolean;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      title={
        needsReview
          ? "Remove from review queue"
          : "Mark to review later"
      }
      onClick={() => {
        startTransition(async () => {
          await setTransactionNeedsReview({
            transactionId,
            needsReview: !needsReview,
          });
        });
      }}
      className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide disabled:opacity-50 ${
        needsReview
          ? "border-amber-400 text-amber-800 dark:border-amber-600 dark:text-amber-200"
          : "border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
      }`}
    >
      {needsReview ? "Review ✓" : "Review"}
    </button>
  );
}
