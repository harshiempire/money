"use client";

import { useRef, useState } from "react";

export function CopyBalanceSummary({ summary }: { summary: string }) {
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  async function copySummary() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(summary);
      setStatus("copied");
    } catch {
      // Some mobile browsers do not expose the Clipboard API. Leave the text
      // selected so it can still be copied through the browser's native menu.
      summaryRef.current?.focus();
      summaryRef.current?.select();
      setStatus("error");
    }
  }

  return (
    <section className="mt-6 rounded border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Balance summary</h2>
        <button
          type="button"
          onClick={copySummary}
          className="rounded border border-neutral-300 px-2 py-1 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {status === "copied" ? "Copied" : "Copy summary"}
        </button>
      </div>
      <p className="mt-1 text-xs text-neutral-500" aria-live="polite">
        {status === "copied"
          ? "Copied to clipboard."
          : status === "error"
            ? "Clipboard is unavailable. The summary is selected below; copy it from the browser menu."
            : "Current outstanding items only."}
      </p>
      <textarea
        ref={summaryRef}
        readOnly
        value={summary}
        aria-label="Selectable balance summary"
        className="mt-3 min-h-48 w-full resize-y rounded border border-neutral-200 bg-transparent p-2 font-mono text-xs leading-5 dark:border-neutral-800"
      />
    </section>
  );
}
