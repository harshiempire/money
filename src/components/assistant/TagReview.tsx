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
  offers: Array<{
    counterpartyId: string;
    categoryId: string;
    categoryName: string;
    payee: string;
    existingCategoryId?: string;
    existingCategoryName?: string;
  }>;
  savedIds: string[];
  failedRows: Array<{ transactionId: string; label: string; reason: string }>;
  stopped?: boolean;
  undone?: boolean;
  undoNote?: string;
}

type Filter = "all" | "high" | "look";

export type RememberChoiceResult =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; confirm: true; existingCategoryId: string; existingCategoryName: string; nextCategoryName: string };

type RememberPrompt = {
  existingCategoryId: string;
  existingCategoryName: string;
  nextCategoryName: string;
};

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

function canRememberPayee(counterpartyId: string | null, payee: string): boolean {
  if (!counterpartyId) return false;
  if (payee.includes("@") || /\d{5,}/.test(payee)) return false;
  return true;
}

function sheetCategories(
  row: TagDraftRow,
  categories: CategoryLite[],
  selectedId: string | null,
  selectedName: string | null,
): Array<{ id: string; name: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; name: string }> = [];
  const push = (id: string, name: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, name });
  };
  if (selectedId && selectedName) push(selectedId, selectedName);
  for (const choice of row.choices) push(choice.categoryId, choice.name);
  for (const category of categories) push(category.id, category.name);
  return out;
}

function rememberCheckboxLabel(input: {
  payee: string;
  nextName: string | null;
  existingName: string | null;
  differs: boolean;
  prompt: RememberPrompt | null;
}): string {
  const saves = "This saves immediately.";
  if (input.prompt) {
    return `Remember for this payee. ${input.payee}'s default is ${input.prompt.existingCategoryName}. Change it to ${input.prompt.nextCategoryName}? ${saves}`;
  }
  if (input.differs && input.existingName && input.nextName) {
    return `Remember for this payee. ${input.payee}'s default is ${input.existingName}. Change it to ${input.nextName}? ${saves}`;
  }
  return `Remember for this payee. ${saves}`;
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

function ApplyResultBar({
  result,
  onUndo,
  onRemember,
  onDismissOffer,
}: {
  result: TagReviewResult;
  onUndo: () => void;
  onRemember: (offer: TagReviewResult["offers"][number]) => void;
  onDismissOffer: (counterpartyId: string) => void;
}) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">After applying</div>
      <div className="mt-1 flex max-w-full flex-wrap items-center justify-between gap-3 rounded-xl bg-neutral-900 px-4 py-3 text-sm text-white">
        <div className="min-w-0 max-w-full break-words">
          {result.undone
            ? (result.undoNote ?? "Undone.")
            : `Saved ${result.applied} transaction${result.applied === 1 ? "" : "s"}${
                result.names.length ? ` · ${result.names.join(", ")}` : ""
              }.${
                result.failedRows.length
                  ? ` ${result.failedRows.length} not saved${result.stopped ? " because the save stopped" : ""}.`
                  : ""
              } Undo covers the saved rows.`}
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
          {!result.undone &&
            result.offers.map((offer) =>
              offer.existingCategoryName ? (
                <span key={offer.counterpartyId} className="max-w-full break-words text-xs text-neutral-200">
                  {offer.payee}&apos;s default is {offer.existingCategoryName}. Change it to {offer.categoryName}?{" "}
                  <button
                    type="button"
                    className="underline"
                    aria-label={`Change ${offer.existingCategoryName} to ${offer.categoryName} for ${offer.payee}`}
                    onClick={() => onRemember(offer)}
                  >
                    Change it
                  </button>
                  {" · "}
                  <button
                    type="button"
                    className="underline"
                    aria-label={`Keep ${offer.existingCategoryName} for ${offer.payee}`}
                    onClick={() => onDismissOffer(offer.counterpartyId)}
                  >
                    Keep it
                  </button>
                </span>
              ) : (
                <span key={offer.counterpartyId} className="max-w-full break-words text-xs text-neutral-200">
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
              ),
            )}
          {!result.undone && (
            <button type="button" onClick={onUndo} className="rounded-lg border border-neutral-500 px-3 py-1 text-xs">
              Undo
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function TagReview({
  label,
  total,
  loaded,
  loading,
  applying,
  applyDone,
  applyTotal,
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
  onRememberChoice,
  onDismissOffer,
}: {
  label: string;
  total: number;
  loaded: number;
  loading: boolean;
  applying: boolean;
  applyDone: number;
  applyTotal: number;
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
  onRememberChoice: (offer: TagReviewResult["offers"][number]) => Promise<RememberChoiceResult>;
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
  const sheetRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const [confirmPrompt, setConfirmPrompt] = useState<Record<string, RememberPrompt>>({});
  const [rememberingId, setRememberingId] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  useEffect(() => {
    if ((applying || result) && editing) setEditing(null);
  }, [applying, result, editing]);

  useEffect(() => {
    if (!editing) {
      const opener = openerRef.current;
      openerRef.current = null;
      opener?.focus();
      return;
    }
    if (!window.matchMedia("(width < 640px)").matches) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    sheet.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setEditing(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        sheet.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        sheet.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && focusable.includes(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [editing]);

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

  const choose = (row: TagDraftRow, categoryId: string, close = true) => {
    setChosen((prev) => ({ ...prev, [row.txnId]: categoryId }));
    setSkipped((prev) => {
      const next = new Set(prev);
      next.delete(row.txnId);
      return next;
    });
    setSelected((prev) => new Set(prev).add(row.txnId));
    if (row.counterpartyId) {
      const counterpartyId = row.counterpartyId;
      setConfirmPrompt((prev) => {
        if (!prev[counterpartyId]) return prev;
        const next = { ...prev };
        delete next[counterpartyId];
        return next;
      });
    }
    setSheetError(null);
    if (close) setEditing(null);
  };

  const applySelected = () =>
    onApply(
      selectedRows.map((row) => ({
        transactionId: row.txnId,
        categoryId: categoryFor(row) ?? "",
        expectedCurrentCategoryId: txns[row.txnId]?.categoryId ?? null,
      })),
    );

  const skip = (row: TagDraftRow) => {
    setSkipped((prev) => new Set(prev).add(row.txnId));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(row.txnId);
      return next;
    });
  };

  const confirmRemember = async (row: TagDraftRow) => {
    const categoryId = categoryFor(row);
    const counterpartyId = row.counterpartyId;
    if (!categoryId || !counterpartyId || rememberingId) return;
    const payee = txns[row.txnId]?.label ?? "this payee";
    const prompt = confirmPrompt[counterpartyId] ?? null;
    const nextName = nameOf(categoryId);
    const existingName = nameOf(row.defaultCategoryId);
    const differs = Boolean(row.defaultCategoryId && row.defaultCategoryId !== categoryId && existingName && nextName);
    const confirmFrom = prompt?.existingCategoryId ?? (differs ? row.defaultCategoryId : null);
    setRememberingId(counterpartyId);
    setSheetError(null);
    try {
      const res = await onRememberChoice({
        counterpartyId,
        categoryId,
        categoryName: nextName ?? prompt?.nextCategoryName ?? "this category",
        payee,
        ...(confirmFrom
          ? {
              existingCategoryId: confirmFrom,
              existingCategoryName: prompt?.existingCategoryName ?? nameOf(confirmFrom) ?? undefined,
            }
          : {}),
      });
      if (res.ok) {
        setConfirmPrompt((prev) => {
          if (!prev[counterpartyId]) return prev;
          const next = { ...prev };
          delete next[counterpartyId];
          return next;
        });
        return;
      }
      if ("confirm" in res) {
        setConfirmPrompt((prev) => ({
          ...prev,
          [counterpartyId]: {
            existingCategoryId: res.existingCategoryId,
            existingCategoryName: res.existingCategoryName,
            nextCategoryName: res.nextCategoryName,
          },
        }));
        return;
      }
      setSheetError(res.error);
    } finally {
      setRememberingId(null);
    }
  };

  const editingRow = rows.find((row) => row.txnId === editing) ?? null;

  return (
    <div className="fixed inset-0 z-[60] flex max-sm:flex-col max-sm:overflow-hidden bg-neutral-100 sm:items-start sm:justify-center sm:overflow-y-auto sm:bg-neutral-100/90 sm:px-4 sm:py-8">
      <div className="flex min-h-0 w-full flex-1 flex-col sm:block sm:h-auto sm:max-w-[1040px] sm:flex-none">
        <section className="flex min-h-0 flex-1 flex-col bg-white sm:block sm:flex-none sm:rounded-2xl sm:border sm:border-neutral-200 sm:shadow-[0_18px_50px_rgba(0,0,0,.12)]">
          <header className="flex items-start justify-between gap-3 px-4 pb-3 pt-4 sm:px-5">
            <div className="min-w-0">
              <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold text-neutral-900">
                <span aria-hidden className="shrink-0">✦</span>
                <span className="min-w-0">Review suggested tags</span>
              </h2>
              <p className="mt-0.5 text-xs text-neutral-500">
                <span className="sm:hidden">
                  {loading
                    ? `Suggesting tags for ${label || "this month"} · ${loaded} of ${total || "…"} · nothing is saved until you press Apply, except a payee default you tick Remember on, which saves right away`
                    : `Ask Money found ${total} untagged transaction${total === 1 ? "" : "s"} in ${label} · nothing is saved until you press Apply, except a payee default you tick Remember on, which saves right away`}
                </span>
                <span className="hidden sm:inline">
                  {loading
                    ? `Suggesting tags for ${label || "this month"} · ${loaded} of ${total || "…"} · nothing is saved yet`
                    : `Ask Money found ${total} untagged transaction${total === 1 ? "" : "s"} in ${label} · nothing is saved until you press Apply`}
                </span>
              </p>
            </div>
            <span className="shrink-0 whitespace-nowrap rounded-full border border-neutral-200 px-2.5 py-1 text-[11px] text-neutral-600">
              ✦ Ask Money
            </span>
          </header>

          {error && <p className="px-4 pb-2 text-xs font-medium text-red-600 sm:px-5">{error}</p>}
          {suggester === "history" && !loading && rows.length > 0 && (
            <p className="px-4 pb-2 text-[11px] text-amber-700 sm:px-5">
              ChatGPT didn&apos;t suggest the open rows, so only history and notes are filled in. The rest say no suggestion.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 px-4 pb-3 sm:px-5">
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

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:hidden">
            <ul className="space-y-2">
              {visible.map((row) => {
                const txn = txns[row.txnId];
                const categoryId = categoryFor(row);
                const categoryName = nameOf(categoryId);
                const isSelected = selected.has(row.txnId) && !skipped.has(row.txnId);
                const isSkipped = skipped.has(row.txnId) || row.source === "none";
                const locked = Boolean(result) || applying;
                const saved = result?.savedIds.includes(row.txnId) && !result.undone;
                const rowFailure = result?.failedRows.find((item) => item.transactionId === row.txnId);
                const payee = txn?.label ?? "Payment";
                return (
                  <li key={row.txnId} className="rounded-xl border border-neutral-200 bg-white p-3">
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${payee}`}
                        className="mt-1"
                        checked={isSelected}
                        disabled={locked || !categoryId}
                        onChange={() => toggle(row)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="break-words font-medium text-neutral-900">{payee}</div>
                            <div className="break-words text-xs text-neutral-500">
                              {txn ? `${shortMonthDay(txn.txnDate)} · ` : ""}
                              {row.transfer ? "Flagged as a transfer. " : ""}
                              {row.reason}
                            </div>
                          </div>
                          <div className="shrink-0 font-medium tabular-nums text-neutral-900">
                            {txn ? formatPaisePlain(txn.amountPaise) : ""}
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {categoryName ? (
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${pillClass(categoryName)}`}>
                              {categoryName}
                            </span>
                          ) : (
                            <span className="text-[11px] text-neutral-400">No suggestion</span>
                          )}
                          <span className="text-xs">
                            <ConfidenceCue level={row.confidence} />
                          </span>
                        </div>
                        {saved && <div className="mt-1 text-[11px] font-medium text-emerald-700">Saved</div>}
                        {rowFailure && !result?.undone && (
                          <div className="mt-1 text-[11px] font-medium text-red-600">Not saved. {rowFailure.reason}</div>
                        )}
                        <div className="mt-2 flex flex-nowrap items-center gap-1">
                          <button
                            type="button"
                            disabled={locked || !categoryId}
                            onClick={() => {
                              if (!isSelected) toggle(row);
                            }}
                            className={`inline-flex min-h-10 shrink-0 items-center justify-center whitespace-nowrap rounded-md px-2.5 text-[11px] ${
                              isSelected ? "bg-emerald-500 text-white" : "border border-neutral-200 text-neutral-500"
                            }`}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={locked}
                            aria-expanded={editing === row.txnId}
                            aria-haspopup="dialog"
                            onClick={(event) => {
                              if (editing === row.txnId) {
                                setEditing(null);
                                return;
                              }
                              openerRef.current = event.currentTarget;
                              setEditing(row.txnId);
                            }}
                            className={`inline-flex min-h-10 shrink-0 items-center justify-center whitespace-nowrap rounded-md px-2.5 text-[11px] ${
                              editing === row.txnId ? "bg-amber-100 text-amber-900" : "border border-neutral-200 text-neutral-600"
                            }`}
                          >
                            Change
                          </button>
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => skip(row)}
                            className={`inline-flex min-h-10 shrink-0 items-center justify-center whitespace-nowrap rounded-md px-2.5 text-[11px] ${
                              isSkipped ? "bg-neutral-200 text-neutral-500" : "border border-neutral-200 text-neutral-600"
                            }`}
                          >
                            {isSkipped ? "Skipped" : "Skip"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {!loading && visible.length === 0 && (
              <p className="px-2 py-8 text-center text-sm text-neutral-500">
                {rows.length === 0 ? `${label} has no untagged transactions.` : "Nothing in this filter."}
              </p>
            )}
          </div>

          <div className="hidden overflow-x-auto sm:block">
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
                  const saved = result?.savedIds.includes(row.txnId) && !result.undone;
                  const rowFailure = result?.failedRows.find((item) => item.transactionId === row.txnId);
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
                        {saved && <div className="text-[11px] font-medium text-emerald-700">Saved</div>}
                        {rowFailure && !result?.undone && (
                          <div className="text-[11px] font-medium text-red-600">Not saved. {rowFailure.reason}</div>
                        )}
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
                            onClick={() => skip(row)}
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

          <footer className="hidden flex-wrap items-center justify-between gap-3 border-t border-neutral-200 px-5 py-3 sm:flex">
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
                  onClick={applySelected}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {applying ? `Saving ${applyDone} of ${applyTotal}…` : `Apply selected (${selectedRows.length})`}
                </button>
              )}
            </div>
          </footer>
        </section>

        {result && (
          <div className="mt-4 hidden sm:block">
            <ApplyResultBar result={result} onUndo={onUndo} onRemember={onRemember} onDismissOffer={onDismissOffer} />
          </div>
        )}
      </div>

      <div className="max-h-[40vh] shrink-0 overflow-y-auto overscroll-contain border-t border-neutral-200 bg-white px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:hidden">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-neutral-900">
              {selectedRows.length} of {rows.length} selected · {formatPaisePlain(totalPaise)}
            </div>
            <p className="text-[11px] text-neutral-500">
              Skipped and low-confidence rows stay untagged. Amounts come from your data, never from the AI.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label={result ? "Close review" : "Cancel review"}
            className="shrink-0 pt-0.5 text-sm text-neutral-600"
          >
            {result ? "Close" : "Cancel"}
          </button>
        </div>
        {!result && (
          <button
            type="button"
            disabled={loading || applying || selectedRows.length === 0}
            onClick={applySelected}
            className="mt-2 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {applying ? `Saving ${applyDone} of ${applyTotal}…` : `Apply selected (${selectedRows.length})`}
          </button>
        )}
        {result && (
          <div className="mt-2">
            <ApplyResultBar result={result} onUndo={onUndo} onRemember={onRemember} onDismissOffer={onDismissOffer} />
          </div>
        )}
      </div>

      {editingRow && (
        <div className="fixed inset-0 z-[70] sm:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close category choices"
            onClick={() => setEditing(null)}
          />
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="tag-change-title"
            tabIndex={-1}
            className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl bg-white px-4 pt-3 shadow-[0_-12px_40px_rgba(0,0,0,.18)] pb-[max(1rem,env(safe-area-inset-bottom))] outline-none"
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-200" />
            <div className="flex items-center justify-between gap-3">
              <h3 id="tag-change-title" className="text-sm font-semibold text-neutral-900">
                Change tag
              </h3>
              <button type="button" onClick={() => setEditing(null)} className="text-sm text-neutral-600">
                Done
              </button>
            </div>
            <p className="mt-1 break-words text-xs text-neutral-500">
              {txns[editingRow.txnId]?.label ?? "Payment"}
              {txns[editingRow.txnId] ? ` · ${formatPaisePlain(txns[editingRow.txnId].amountPaise)}` : ""}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {sheetCategories(editingRow, categories, categoryFor(editingRow), nameOf(categoryFor(editingRow))).map((category) => {
                const selected = categoryFor(editingRow) === category.id;
                return (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => choose(editingRow, category.id, false)}
                    aria-pressed={selected}
                    className={`inline-flex min-h-10 items-center justify-center rounded-full px-3 text-xs font-medium ${pillClass(category.name)} ${
                      selected ? "ring-2 ring-neutral-900 ring-offset-1" : ""
                    }`}
                  >
                    {category.name}
                  </button>
                );
              })}
            </div>
            {canRememberPayee(editingRow.counterpartyId, txns[editingRow.txnId]?.label ?? "this payee") && (
              <RememberRow
                row={editingRow}
                payee={txns[editingRow.txnId]?.label ?? "this payee"}
                categoryId={categoryFor(editingRow)}
                categoryName={nameOf(categoryFor(editingRow))}
                existingName={nameOf(editingRow.defaultCategoryId)}
                prompt={editingRow.counterpartyId ? (confirmPrompt[editingRow.counterpartyId] ?? null) : null}
                remembering={rememberingId === editingRow.counterpartyId}
                onConfirm={() => void confirmRemember(editingRow)}
              />
            )}
            {sheetError && <p className="mt-2 text-xs font-medium text-red-600">{sheetError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function RememberRow({
  row,
  payee,
  categoryId,
  categoryName,
  existingName,
  prompt,
  remembering,
  onConfirm,
}: {
  row: TagDraftRow;
  payee: string;
  categoryId: string | null;
  categoryName: string | null;
  existingName: string | null;
  prompt: RememberPrompt | null;
  remembering: boolean;
  onConfirm: () => void;
}) {
  const differs = Boolean(categoryId && row.defaultCategoryId && row.defaultCategoryId !== categoryId);
  const already = Boolean(categoryId && row.defaultCategoryId === categoryId);
  const label = rememberCheckboxLabel({ payee, nextName: categoryName, existingName, differs, prompt });
  return (
    <label className="mt-4 flex items-start gap-2 border-t border-neutral-200 pt-3 text-sm text-neutral-800">
      <input
        type="checkbox"
        className="mt-1"
        checked={already}
        disabled={!categoryId || already || remembering}
        onChange={onConfirm}
      />
      <span>{label}</span>
    </label>
  );
}
