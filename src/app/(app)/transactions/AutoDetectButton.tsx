"use client";

import { useState, useTransition } from "react";
import { autoDetectTransfers } from "./actions";
import { Button } from "@/components/ui/Button";

export function AutoDetectButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
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
        title="Find unmarked debit/credit pairs of the same amount within 3 days and mark both as transfer"
      >
        {pending ? "Scanning…" : "Auto-detect transfers"}
      </Button>
      {result && (
        <span className="text-xs text-[var(--color-text-muted)]">{result}</span>
      )}
    </div>
  );
}
