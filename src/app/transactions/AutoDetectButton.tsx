"use client";

import { useState, useTransition } from "react";
import { autoDetectTransfers } from "./actions";

export function AutoDetectButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setResult(null);
          startTransition(async () => {
            const r = await autoDetectTransfers();
            setResult(
              r.pairs === 0
                ? "No new pairs found"
                : `Marked ${r.pairs} pair${r.pairs === 1 ? "" : "s"} as transfer`,
            );
          });
        }}
        className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        title="Find unmarked debit/credit pairs of the same amount within 3 days and mark both as transfer"
      >
        {pending ? "Scanning…" : "Auto-detect transfers"}
      </button>
      {result && (
        <span className="text-xs text-neutral-500">{result}</span>
      )}
    </div>
  );
}
