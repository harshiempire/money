const PALETTE: Record<string, string> = {
  upi: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200",
  imps: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  neft: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  rtgs: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  opening: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

export function ChannelPill({ channel }: { channel: string }) {
  const cls =
    PALETTE[channel] ??
    "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {channel}
    </span>
  );
}
