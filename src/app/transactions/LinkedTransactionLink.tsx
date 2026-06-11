"use client";

import { useRef, useState, useTransition } from "react";
import {
  formatDate,
  formatPaise,
  formatPaiseSigned,
} from "@/lib/format";
import { transactionHref } from "@/lib/transactions/href";
import {
  getLinkedTransactionPreview,
  type LinkedTransactionPreview,
} from "./actions";
import type { SplitSettlementStatus } from "@/lib/splits/settlement-status";

function scrollToTransaction(id: string) {
  const el = document.getElementById(`txn-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add(
    "ring-2",
    "ring-sky-500/70",
    "ring-offset-2",
    "ring-offset-white",
    "dark:ring-offset-neutral-950",
  );
  window.setTimeout(() => {
    el.classList.remove(
      "ring-2",
      "ring-sky-500/70",
      "ring-offset-2",
      "ring-offset-white",
      "dark:ring-offset-neutral-950",
    );
  }, 4000);
}

export function LinkedTransactionLink({
  transactionId,
  visibleTxnIds,
  className,
  title,
  children,
}: {
  transactionId: string;
  visibleTxnIds: readonly string[];
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  const onPage = visibleTxnIds.includes(transactionId);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<LinkedTransactionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const openPreview = () => {
    setError(null);
    setPreview(null);
    dialogRef.current?.showModal();
    startTransition(async () => {
      try {
        const data = await getLinkedTransactionPreview({ transactionId });
        setPreview(data);
      } catch {
        setError("Could not load this transaction.");
      }
    });
  };

  if (onPage) {
    return (
      <a
        href={`#txn-${transactionId}`}
        className={className}
        title={title}
        onClick={(e) => {
          e.preventDefault();
          scrollToTransaction(transactionId);
        }}
      >
        {children}
      </a>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`inline cursor-pointer border-0 bg-transparent p-0 text-left ${className ?? ""}`}
        title={title ?? "Preview linked transaction"}
        onClick={openPreview}
      >
        {children}
      </button>
      <dialog
        ref={dialogRef}
        className="rounded-lg p-0 backdrop:bg-black/40 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <PreviewPanel
          preview={preview}
          error={error}
          pending={pending}
          onClose={() => dialogRef.current?.close()}
        />
      </dialog>
    </>
  );
}

function splitStatusLabel(status: SplitSettlementStatus): string {
  switch (status) {
    case "settled":
      return "Fully settled";
    case "partial":
      return "Partially settled";
    case "open":
      return "Pending reimbursement";
    default:
      return "";
  }
}

function PreviewPanel({
  preview,
  error,
  pending,
  onClose,
}: {
  preview: LinkedTransactionPreview | null;
  error: string | null;
  pending: boolean;
  onClose: () => void;
}) {
  return (
    <div className="w-[28rem] max-w-[90vw] p-5">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Linked transaction</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-neutral-500 hover:underline"
        >
          Close
        </button>
      </header>

      {pending && !preview && !error && (
        <p className="text-sm text-neutral-500">Loading…</p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {preview && (
        <>
          <p className="text-xs text-neutral-500">
            From a different statement period — your current list stays as-is.
          </p>

          <div className="mt-3 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <div className="font-mono text-xs text-neutral-500">
              {formatDate(preview.txnDate)} · {preview.channel}
            </div>
            <div className="mt-1 font-medium">{preview.counterpartyLabel}</div>
            {preview.parsedPurpose && (
              <div className="mt-0.5 text-xs text-neutral-500">
                {preview.parsedPurpose}
              </div>
            )}
            {preview.note && (
              <div className="mt-1 text-xs italic text-owed-to-me">
                {preview.note}
              </div>
            )}
            <div
              className={`mt-2 font-mono text-base ${
                preview.drCr === "debit"
                  ? "text-spend"
                  : "text-inflow"
              }`}
            >
              {formatPaiseSigned(preview.amountPaise, preview.drCr)}
            </div>
          </div>

          {preview.split && preview.split.status !== "none" && (
            <div className="mt-3 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
              <div className="text-xs uppercase text-neutral-500">Split</div>
              <div className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                {splitStatusLabel(preview.split.status)} · your share{" "}
                {formatPaise(preview.split.yourSharePaise)}
              </div>
              <div className="mt-1 font-mono text-xs text-neutral-500">
                {formatPaise(preview.split.settledReimbursePaise)} of{" "}
                {formatPaise(preview.split.expectedReimbursePaise)} received ·{" "}
                {formatPaise(preview.split.outstandingReimbursePaise)} pending
              </div>
              <ul className="mt-2 space-y-1 text-xs">
                {preview.split.participants.map((p) => (
                  <li
                    key={p.personName}
                    className="flex justify-between gap-2 text-neutral-600 dark:text-neutral-400"
                  >
                    <span>{p.personName}</span>
                    <span className="font-mono">
                      {formatPaise(p.settledAmountPaise)} /{" "}
                      {formatPaise(p.expectedAmountPaise)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <footer className="mt-4 flex justify-end">
            <a
              href={transactionHref(preview.id)}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
            >
              Open in statement →
            </a>
          </footer>
        </>
      )}
    </div>
  );
}
