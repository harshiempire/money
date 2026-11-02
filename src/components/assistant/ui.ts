/** Class names for the assistant, matching the handoff's tokens in both themes. */

const chipBase = "whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide disabled:opacity-50";

export const chip = {
  neutral: `${chipBase} border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800`,
  amber: `${chipBase} border-amber-500 text-amber-700 dark:border-amber-700 dark:text-amber-300`,
  green: `${chipBase} border-emerald-500 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300`,
  violet: `${chipBase} border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950`,
};

export const card = "rounded-md border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-[#1a1a1a]";

export const input =
  "rounded border border-neutral-300 bg-transparent px-2 py-1 text-[13px] outline-none focus:border-neutral-500 read-only:text-neutral-500 dark:border-neutral-700 dark:read-only:text-neutral-400";

export const label = "text-[11px] uppercase text-neutral-500";

export const primaryButton =
  "rounded bg-neutral-900 px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900";

export const ghostButton =
  "rounded px-2.5 py-1.5 text-[13px] text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100";

export const outlineButton =
  "rounded border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400";

export { modelDate as prettyDate } from "@/lib/assistant/model-view";
