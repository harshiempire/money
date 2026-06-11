"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export function InfoPopover({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={containerRef} className="relative inline-block align-middle">
      <button
        type="button"
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-neutral-300 text-[10px] leading-none text-neutral-500 dark:border-neutral-700"
        aria-label="Explain"
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-0 z-20 mt-1 w-64 rounded border border-neutral-200 bg-white p-3 text-xs text-neutral-600 shadow-lg dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400"
        >
          {children}
        </span>
      )}
    </span>
  );
}
