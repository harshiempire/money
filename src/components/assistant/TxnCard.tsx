"use client";

import { ChannelPill } from "@/components/ui/ChannelPill";
import { formatDate, formatPaise, formatPaiseSigned } from "@/lib/format";
import type { CategoryLite, TxnCardData } from "@/lib/assistant/types";
import { card, chip } from "./ui";

/** Status line under the payee, like the table's "↳" line. */
export function statusLine(t: TxnCardData): { text: string; settled: boolean } | null {
  if (t.drCr === "credit") return t.netEventId ? { text: "Net settled", settled: true } : null;
  if (!t.split) return null;
  const { participants, settled, pendingPaise } = t.split;
  return settled === participants
    ? { text: `${settled}/${participants} settled`, settled: true }
    : { text: `${settled}/${participants} settled · ${formatPaise(pendingPaise)} pending`, settled: false };
}

/** "Why it matched" — computed from the row by the server, never by the model. */
export function MatchReasons({ reasons, compact = false }: { reasons: string[] | undefined; compact?: boolean }) {
  if (!reasons || reasons.length === 0) return null;
  return (
    <div className={compact ? "mt-0.5" : "mt-2 border-t border-neutral-200 pt-2 dark:border-neutral-800"}>
      {!compact && <div className="text-[10px] uppercase tracking-wide text-neutral-500">Why it matched · from Money data</div>}
      <ul className={`${compact ? "" : "mt-1 "}space-y-px text-[11px] text-neutral-600 dark:text-neutral-400`}>
        {reasons.map((r) => (
          <li key={r}>✓ {r}</li>
        ))}
      </ul>
    </div>
  );
}

export function TxnSummary({ t }: { t: TxnCardData }) {
  const status = statusLine(t);
  return (
    <div className="text-sm">
      <div className="font-medium">{t.label}</div>
      {t.purpose && <div className="text-xs text-neutral-500">{t.purpose}</div>}
      {t.note && <div className="mt-0.5 text-xs italic text-owed-to-me">{t.note}</div>}
      {status && (
        <div
          className={`mt-0.5 text-[11px] ${
            status.settled ? "text-emerald-700 dark:text-emerald-300/90" : "text-amber-700 dark:text-amber-300/90"
          }`}
        >
          <span className="opacity-70">↳</span> <span className="font-medium">{status.text}</span>
        </div>
      )}
    </div>
  );
}

export function TxnCard({
  t,
  reasons,
  categories,
  busy,
  onCategory,
  onSplit,
  onNet,
  onNote,
  onReview,
  onOpen,
}: {
  t: TxnCardData;
  reasons?: string[];
  categories: CategoryLite[];
  busy: boolean;
  /** Opens a pending category card — the dropdown never saves by itself. */
  onCategory: (categoryId: string) => void;
  onSplit: () => void;
  onNet: () => void;
  onNote: () => void;
  onReview: () => void;
  onOpen: () => void;
}) {
  const allSettled = t.split && t.split.settled === t.split.participants;
  const splitLabel = t.drCr === "credit" ? "Settle" : t.split ? (allSettled ? "Split done ✓" : "Split · pending") : "Split";
  const splitClass = t.drCr === "debit" && t.split ? (allSettled ? chip.green : chip.amber) : chip.neutral;

  return (
    <div className={`${card} p-3`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-neutral-500">{formatDate(t.txnDate)}</span>
          <ChannelPill channel={t.channel} />
        </div>
        <span
          className={`whitespace-nowrap font-mono text-xs ${t.drCr === "debit" ? "text-spend" : "text-inflow"}`}
        >
          {formatPaiseSigned(t.amountPaise, t.drCr)}
        </span>
      </div>
      <div className="mt-2">
        <TxnSummary t={t} />
      </div>
      <MatchReasons reasons={reasons} />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <select
          value={t.categoryId ?? ""}
          disabled={busy}
          onChange={(e) => onCategory(e.target.value)}
          aria-label="Category"
          className="rounded border border-neutral-300 bg-transparent px-1.5 py-0.5 text-xs dark:border-neutral-700"
        >
          <option value="">—</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy} onClick={onSplit} className={splitClass}>
          {splitLabel}
        </button>
        {t.drCr === "credit" && (
          <button type="button" disabled={busy} onClick={onNet} className={chip.violet}>
            {t.netEventId ? "Net ✓" : "Net settle"}
          </button>
        )}
        <button type="button" disabled={busy} onClick={onNote} className={t.note ? chip.amber : chip.neutral}>
          {t.note ? "Note ✎" : "Note…"}
        </button>
        <button type="button" disabled={busy} onClick={onReview} className={t.needsReview ? chip.amber : chip.neutral}>
          {t.needsReview ? "Flagged" : "Review"}
        </button>
        <button
          type="button"
          onClick={onOpen}
          className="ml-auto text-[11px] text-neutral-500 hover:text-neutral-900 hover:underline dark:hover:text-neutral-100"
        >
          Open in table ↗
        </button>
      </div>
    </div>
  );
}

export function PickList({
  txns,
  total,
  reasons,
  picked,
  onPick,
}: {
  txns: TxnCardData[];
  total: number;
  reasons: Record<string, string[]> | undefined;
  picked: string | undefined;
  onPick: (id: string) => void;
}) {
  return (
    <div className={`${card} overflow-hidden`}>
      <div className="border-b border-neutral-200 px-3 py-2 text-[10px] uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
        {picked
          ? "Selected"
          : total > txns.length
            ? `${total} matches — best ${txns.length} shown, pick one`
            : `${total} matches — pick one`}
        {!picked && <span className="normal-case tracking-normal"> · reasons from Money data</span>}
      </div>
      {txns.map((t) => {
        const selected = picked === t.id;
        return (
          <button
            key={t.id}
            type="button"
            disabled={Boolean(picked)}
            onClick={() => onPick(t.id)}
            className={`flex w-full items-center gap-2.5 border-t border-neutral-100 px-3 py-2 text-left first:border-t-0 dark:border-[#1f1f1f] ${
              selected ? "bg-neutral-200 dark:bg-neutral-800" : "hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
            } ${picked && !selected ? "opacity-45" : ""}`}
          >
            <span className="w-3.5 text-xs text-inflow">{selected ? "✓" : ""}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-mono text-[11px] text-neutral-500">{formatDate(t.txnDate)}</span>
              <span className="truncate text-[13px] font-medium">{t.label}</span>
              {t.note && <span className="truncate text-[11px] italic text-owed-to-me">{t.note}</span>}
              {!picked && <MatchReasons reasons={reasons?.[t.id]} compact />}
            </span>
            <span
              className={`whitespace-nowrap font-mono text-xs ${t.drCr === "debit" ? "text-spend" : "text-inflow"}`}
            >
              {formatPaiseSigned(t.amountPaise, t.drCr)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
