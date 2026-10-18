"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatPaisePlain } from "@/lib/format";
import { MONTH_ABBR } from "@/lib/assistant/model-view";
import {
  confidenceLabel,
  monthTitle,
  rowPreselected,
  shortMonthDay,
  type TagConfidence,
  type TagDraftRow,
  type UntaggedMonth,
} from "@/lib/assistant/tag-batch";
import type { CategoryLite, TxnCardData } from "@/lib/assistant/types";

export interface TagApplySelection {
  transactionId: string;
  categoryId: string;
  expectedCurrentCategoryId: string | null;
}

export interface TagReviewResult {
  applied: number;
  failed: number;
  left: number;
  names: string[];
  offers: Array<{ counterpartyId: string; categoryId: string; categoryName: string; payee: string }>;
  undone?: boolean;
  undoNote?: string;
}

type Filter = "all" | "high" | "look";

const PILL: Record<string, string> = {
  Food: "bg-orange-100 text-orange-900",
  Travel: "bg-sky-100 text-sky-900",
  Subscriptions: "bg-violet-100 text-violet-900",
  "Dining out": "bg-amber-100 text-amber-900",
  Cash: "bg-emerald-100 text-emerald-900",
  Groceries: "bg-lime-100 text-lime-900",
  Shopping: "bg-pink-100 text-pink-900",
  Bills: "bg-yellow-100 text-yellow-900",
  Entertainment: "bg-fuchsia-100 text-fuchsia-900",
  "Self transfer": "bg-neutral-200 text-neutral-800",
  Family: "bg-rose-100 text-rose-900",
  Investment: "bg-indigo-100 text-indigo-900",
  Reimbursement: "bg-teal-100 text-teal-900",
  Income: "bg-green-100 text-green-900",
};

function pillClass(name: string): string {
  return PILL[name] ?? "bg-neutral-100 text-neutral-800";
}

function ConfidenceCue({ level }: { level: TagConfidence }) {
  if (level === "none") return <span className="text-neutral-400">—</span>;
  const filled = level === "high" ? 3 : level === "medium" ? 2 : 1;
  const color = level === "high" ? "bg-emerald-500" : level === "medium" ? "bg-amber-400" : "bg-rose-500";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="inline-flex gap-0.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className={`h-1.5 w-3 rounded-sm ${i < filled ? color : "bg-neutral-200"}`} />
        ))}
      </span>
      <span className={level === "low" ? "text-rose-700" : "text-neutral-700"}>{confidenceLabel(level)}</span>
    </span>
  );
}

export function TagMonthButton({
  months,
  disabled,
  onTag,
}: {
  months: UntaggedMonth[];
  disabled: boolean;
  onTag: (year: number, month: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const latest = months[0];
  if (!latest) return null;
  return (
    <div className="relative inline-flex">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onTag(latest.year, latest.month)}
        className="rounded border border-neutral-300 px-2 py-1 text-left text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
      >
        Tag {MONTH_ABBR[latest.month - 1]}
      </button>
      {months.length > 1 && (
        <button
          type="button"
          disabled={disabled}
          aria-label="Choose month"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="rounded-r border border-l-0 border-neutral-300 px-1.5 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-50"
        >
          ▾
        </button>
      )}
      {open && (
        <ul className="absolute bottom-full z-10 mb-1 max-h-48 w-44 overflow-auto rounded-md border border-neutral-200 bg-white py-1 text-xs shadow-lg">
          {months.map((m) => (
            <li key={`${m.year}-${m.month}`}>
              <button
                type="button"
                className="flex w-full items-center justify-between px-2 py-1.5 text-left hover:bg-neutral-100"
                onClick={() => {
                  setOpen(false);
                  onTag(m.year, m.month);
                }}
              >
                <span>{monthTitle(m.year, m.month)}</span>
                <span className="text-neutral-500">{m.count}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TagReview({
  label,
  total,
  loaded,
  loading,
  applying,
  rows,
  txns,
  categories,
  error,
  suggester,
  result,
  onCancel,
  onApply,
  onUndo,
  onRemember,
  onDismissOffer,
}: {
  label: string;
  total: number;
  loaded: number;
  loading: boolean;
  applying: boolean;
  rows: TagDraftRow[];
  txns: Record<string, TxnCardData>;
  categories: CategoryLite[];
  error?: string;
  suggester: "model" | "history" | "stub";
  result: TagReviewResult | null;
  onCancel: () => void;
  onApply: (rows: TagApplySelection[]) => void;
  onUndo: () => void;
  onRemember: (offer: TagReviewResult["offers"][number]) => void;
  onDismissOffer: (counterpartyId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(rows.filter(rowPreselected).map((r) => r.txnId)));
  const seen = useRef(new Set(rows.map((row) => row.txnId)));
  useEffect(() => {
    const fresh = rows.filter((row) => !seen.current.has(row.txnId));
    if (fresh.length === 0) return;
    for (const row of fresh) seen.current.add(row.txnId);
    const add = fresh.filter(rowPreselected).map((row) => row.txnId);
    if (add.length === 0) return;
    setSelected((prev) => new Set([...prev, ...add]));
  }, [rows]);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);

  const nameOf = (id: string | null) => categories.find((c) => c.id === id)?.name ?? null;
  const categoryFor = (row: TagDraftRow) => chosen[row.txnId] ?? row.suggestedCategoryId;

  const visible = rows.filter((row) => {
    if (filter === "high") return row.confidence === "high";
    if (filter === "look") return row.confidence !== "high";
    return true;
  });
  const highRows = rows.filter((row) => row.confidence === "high" && categoryFor(row));
  const allHighSelected = highRows.length > 0 && highRows.every((row) => selected.has(row.txnId));
  const selectedRows = rows.filter((row) => selected.has(row.txnId) && categoryFor(row) && !skipped.has(row.txnId));
  const totalPaise = selectedRows.reduce((sum, row) => sum + (txns[row.txnId]?.amountPaise ?? 0), 0);
  const highCount = rows.filter((row) => row.confidence === "high").length;
  const lookCount = rows.length - highCount;

  const chips = useMemo(
    () =>
      [
        ["all", `All ${rows.length}`],
        ["high", `High confidence ${highCount}`],
        ["look", `Needs a look ${lookCount}`],
      ] as const,
    [rows.length, highCount, lookCount],
  );

  const toggle = (row: TagDraftRow) => {
    if (!categoryFor(row)) return;
    setSkipped((prev) => {
      const next = new Set(prev);
      next.delete(row.txnId);
      return next;
    });
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(row.txnId)) next.delete(row.txnId);
      else next.add(row.txnId);
      return next;
    });
  };

  const choose = (row: TagDraftRow, categoryId: string) => {
    setChosen((prev) => ({ ...prev, [row.txnId]: categoryId }));
    setSkipped((prev) => {
      const next = new Set(prev);
      next.delete(row.txnId);
      return next;
    });
    setSelected((prev) => new Set(prev).add(row.txnId));
    setEditing(null);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-neutral-100/90 px-4 py-8">
      <div className="w-full max-w-[1040px]">
        <section className="rounded-2xl border border-neutral-200 bg-white shadow-[0_18px_50px_rgba(0,0,0,.12)]">
          <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
            <div>
              <h2 className="flex items-center gap-2 text-base font-semibold text-neutral-900">
                <span aria-hidden>✦</span> Review suggested tags
              </h2>
              <p className="mt-0.5 text-xs text-neutral-500">
                {loading
                  ? `Suggesting tags for ${label || "this month"} · ${loaded} of ${total || "…"} · nothing is saved yet`
                  : `Ask Money found ${total} untagged transaction${total === 1 ? "" : "s"} in ${label} · nothing is saved until you press Apply`}
              </p>
            </div>
            <span className="rounded-full border border-neutral-200 px-2.5 py-1 text-[11px] text-neutral-600">✦ Ask Money</span>
          </header>

          {error && <p className="px-5 pb-2 text-xs font-medium text-red-600">{error}</p>}
          {suggester === "history" && !loading && rows.length > 0 && (
            <p className="px-5 pb-2 text-[11px] text-amber-700">
              ChatGPT didn&apos;t suggest the open rows, so only history and notes are filled in. The rest say no suggestion.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
            {chips.map(([id, text]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                className={`rounded-full px-3 py-1 text-xs ${
                  filter === id ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                }`}
              >
                {text}
              </button>
            ))}
            <label className="ml-auto flex items-center gap-2 text-xs text-neutral-600">
              <input
                type="checkbox"
                checked={allHighSelected}
                disabled={highRows.length === 0 || Boolean(result)}
                onChange={() => {
                  setSelected((prev) => {
                    const next = new Set(prev);
                    for (const row of highRows) {
                      if (allHighSelected) next.delete(row.txnId);
                      else next.add(row.txnId);
                    }
                    return next;
                  });
                  if (!allHighSelected) {
                    setSkipped((prev) => {
                      const next = new Set(prev);
                      for (const row of highRows) next.delete(row.txnId);
                      return next;
                    });
                  }
                }}
              />
              Select all high confidence
            </label>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-t border-neutral-200 text-left text-[13px]">
              <thead className="text-[10px] uppercase tracking-wide text-neutral-400">
                <tr>
                  <th className="w-10 px-3 py-2" />
                  <th className="px-2 py-2 font-medium">Date</th>
                  <th className="px-2 py-2 font-medium">Transaction</th>
                  <th className="px-2 py-2 text-right font-medium">Amount</th>
                  <th className="px-2 py-2 font-medium">Suggested tag</th>
                  <th className="px-2 py-2 font-medium">Confidence</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const txn = txns[row.txnId];
                  const categoryId = categoryFor(row);
                  const categoryName = nameOf(categoryId);
                  const isSelected = selected.has(row.txnId) && !skipped.has(row.txnId);
                  const isSkipped = skipped.has(row.txnId) || row.source === "none";
                  const locked = Boolean(result) || applying;
                  const choices = row.choices.filter((c) => !chosen[row.txnId]);
                  return (
                    <tr key={row.txnId} className="border-t border-neutral-100 align-top">
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${txn?.label ?? "transaction"}`}
                          checked={isSelected}
                          disabled={locked || !categoryId}
                          onChange={() => toggle(row)}
                        />
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 text-neutral-600">{txn ? shortMonthDay(txn.txnDate) : ""}</td>
                      <td className="px-2 py-3">
                        <div className="font-medium text-neutral-900">{txn?.label ?? "Payment"}</div>
                        <div className="text-[11px] text-neutral-500">
                          {row.transfer ? "Flagged as a transfer. " : ""}
                          {row.reason}
                        </div>
                        {choices.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {choices.map((choice) => (
                              <button
                                key={choice.categoryId}
                                type="button"
                                disabled={locked}
                                onClick={() => choose(row, choice.categoryId)}
                                className={`rounded-full px-2 py-0.5 text-[11px] ${pillClass(choice.name)}`}
                              >
                                {choice.name}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 text-right font-medium tabular-nums">
                        {txn ? formatPaisePlain(txn.amountPaise) : ""}
                      </td>
                      <td className="px-2 py-3">
                        {editing === row.txnId ? (
                          <select
                            aria-label="Category"
                            className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
                            value={categoryId ?? ""}
                            onChange={(e) => {
                              if (e.target.value) choose(row, e.target.value);
                            }}
                          >
                            <option value="">Choose…</option>
                            {row.choices.map((c) => (
                              <option key={c.categoryId} value={c.categoryId}>
                                {c.name}
                              </option>
                            ))}
                            {categories
                              .filter((c) => !row.choices.some((choice) => choice.categoryId === c.id))
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                          </select>
                        ) : categoryName ? (
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${pillClass(categoryName)}`}>
                            {categoryName}
                          </span>
                        ) : (
                          <span className="text-[11px] text-neutral-400">No suggestion</span>
                        )}
                      </td>
                      <td className="px-2 py-3">
                        <ConfidenceCue level={row.confidence} />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex gap-1">
                          <button
                            type="button"
                            disabled={locked || !categoryId}
                            onClick={() => {
                              if (!isSelected) toggle(row);
                            }}
                            className={`rounded-md px-2 py-1 text-[11px] ${
                              isSelected ? "bg-emerald-500 text-white" : "border border-neutral-200 text-neutral-500"
                            }`}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => setEditing(editing === row.txnId ? null : row.txnId)}
                            className={`rounded-md px-2 py-1 text-[11px] ${
                              editing === row.txnId ? "bg-amber-100 text-amber-900" : "border border-neutral-200 text-neutral-600"
                            }`}
                          >
                            Change
                          </button>
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => {
                              setSkipped((prev) => new Set(prev).add(row.txnId));
                              setSelected((prev) => {
                                const next = new Set(prev);
                                next.delete(row.txnId);
                                return next;
                              });
                            }}
                            className={`rounded-md px-2 py-1 text-[11px] ${
                              isSkipped ? "bg-neutral-200 text-neutral-500" : "border border-neutral-200 text-neutral-600"
                            }`}
                          >
                            {isSkipped ? "Skipped" : "Skip"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!loading && visible.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-5 py-8 text-center text-sm text-neutral-500">
                      {rows.length === 0 ? `${label} has no untagged transactions.` : "Nothing in this filter."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 px-5 py-3">
            <div>
              <div className="text-sm font-medium text-neutral-900">
                {selectedRows.length} of {rows.length} selected · total {formatPaisePlain(totalPaise)}
              </div>
              <p className="text-[11px] text-neutral-500">
                Skipped and low-confidence rows stay untagged. Amounts come from your data, never from the AI.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onCancel}
                aria-label={result ? "Close review" : "Cancel review"}
                className="text-sm text-neutral-600 hover:text-neutral-900"
              >
                {result ? "Close" : "Cancel"}
              </button>
              {!result && (
                <button
                  type="button"
                  disabled={loading || applying || selectedRows.length === 0}
                  onClick={() =>
                    onApply(
                      selectedRows.map((row) => ({
                        transactionId: row.txnId,
                        categoryId: categoryFor(row) ?? "",
                        expectedCurrentCategoryId: txns[row.txnId]?.categoryId ?? null,
                      })),
                    )
                  }
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {applying ? "Applying…" : `Apply selected (${selectedRows.length})`}
                </button>
              )}
            </div>
          </footer>
        </section>

        {result && (
          <div className="mt-4">
            <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">After applying</div>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-neutral-900 px-4 py-3 text-sm text-white">
              <div>
                {result.undone
                  ? (result.undoNote ?? "Undone.")
                  : `Tagged ${result.applied} transaction${result.applied === 1 ? "" : "s"}${
                      result.names.length ? ` · ${result.names.join(", ")}` : ""
                    }. ${result.left} left untagged.`}
                {result.failed > 0 && !result.undone ? ` ${result.failed} could not be updated because they changed.` : ""}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {!result.undone &&
                  result.offers.map((offer) => (
                    <span key={offer.counterpartyId} className="text-xs text-neutral-200">
                      Remember {offer.categoryName} as the default for {offer.payee}?{" "}
                      <button
                        type="button"
                        className="underline"
                        aria-label={`Remember ${offer.categoryName} for ${offer.payee}`}
                        onClick={() => onRemember(offer)}
                      >
                        Yes
                      </button>
                      {" · "}
                      <button
                        type="button"
                        className="underline"
                        aria-label={`Don't remember a default for ${offer.payee}`}
                        onClick={() => onDismissOffer(offer.counterpartyId)}
                      >
                        No
                      </button>
                    </span>
                  ))}
                {!result.undone && (
                  <button type="button" onClick={onUndo} className="rounded-lg border border-neutral-500 px-3 py-1 text-xs">
                    Undo
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
