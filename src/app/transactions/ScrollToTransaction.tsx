"use client";

import { useEffect } from "react";

export function ScrollToTransaction({
  transactionId,
}: {
  transactionId: string | null;
}) {
  useEffect(() => {
    if (!transactionId) return;
    const el = document.getElementById(`txn-${transactionId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add(
      "ring-2",
      "ring-sky-500/70",
      "ring-offset-2",
      "ring-offset-white",
      "dark:ring-offset-neutral-950",
    );
    const timer = window.setTimeout(() => {
      el.classList.remove(
        "ring-2",
        "ring-sky-500/70",
        "ring-offset-2",
        "ring-offset-white",
        "dark:ring-offset-neutral-950",
      );
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [transactionId]);

  return null;
}
