"use client";

import { useRef, useState, useTransition } from "react";
import { formatDate, formatPaise } from "@/lib/format";
import { transactionHref } from "@/lib/transactions/href";
import type { SplitSettlementStatus } from "@/lib/splits/settlement-status";
import {
  CashSettlementButton,
  type CashSettlement,
} from "./CashSettlementDialog";
import { undoWriteOff, writeOffParticipantShare } from "./actions";

export interface WriteoffSettlement {
  id: string;
  amountPaise: number;
  note: string | null;
}

export interface SplitParticipantDetail {
  participantId: string;
  personName: string;
  expectedPaise: number;
  settledPaise: number;
  bankSettledPaise: number;
  cashSettledPaise: number;
  offsetSettledPaise: number;
  writeoffPaise: number;
  outstandingPaise: number;
  cashSettlements: CashSettlement[];
  writeoffSettlements: WriteoffSettlement[];
}

export interface SplitAwaitingItemProps {
  splitId: string;
  txnId: string;
  txnDate: string;
  txnDescription: string;
  txnNote?: string | null;
  status: SplitSettlementStatus;
  expectedReimbursePaise: number;
  settledReimbursePaise: number;
  outstandingReimbursePaise: number;
  settledParticipantCount: number;
  totalParticipantCount: number;
  participants: SplitParticipantDetail[];
}

function splitStatusLabel(status: SplitSettlementStatus): string {
  switch (status) {
    case "settled":
      return "All resolved";
    case "partial":
      return "Partially settled";
    case "open":
      return "Pending";
    default:
      return "";
  }
}

function splitStatusTone(status: SplitSettlementStatus): string {
  switch (status) {
    case "settled":
      return "text-inflow";
    case "partial":
      return "text-amber-800 dark:text-amber-400";
    case "open":
      return "text-amber-800 dark:text-amber-400";
    default:
      return "text-neutral-500";
  }
}

export function SplitAwaitingItem({
  txnId,
  txnDate,
  txnDescription,
  txnNote,
  status,
  expectedReimbursePaise,
  settledReimbursePaise,
  outstandingReimbursePaise,
  settledParticipantCount,
  totalParticipantCount,
  participants,
}: SplitAwaitingItemProps) {
  const [pending, startTransition] = useTransition();
  const forgiveDialogRef = useRef<HTMLDialogElement>(null);
  const [participantToForgive, setParticipantToForgive] =
    useState<SplitParticipantDetail | null>(null);
  const [forgiveReason, setForgiveReason] = useState("");

  const sorted = [...participants].sort((a, b) => {
    if (a.outstandingPaise > 0 !== b.outstandingPaise > 0) {
      return a.outstandingPaise > 0 ? -1 : 1;
    }
    return b.outstandingPaise - a.outstandingPaise;
  });

  const forgetIt = (p: SplitParticipantDetail) => {
    setParticipantToForgive(p);
    setForgiveReason("");
    forgiveDialogRef.current?.showModal();
  };

  const closeForgiveDialog = () => {
    forgiveDialogRef.current?.close();
    setParticipantToForgive(null);
    setForgiveReason("");
  };

  const confirmForgive = () => {
    if (!participantToForgive) return;
    startTransition(async () => {
      try {
        await writeOffParticipantShare({
          splitParticipantId: participantToForgive.participantId,
          note: forgiveReason,
        });
        closeForgiveDialog();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to forgive share";
        console.error("[writeOffParticipantShare]", err);
        window.alert(msg);
      }
    });
  };

  const undo = (settlementId: string) => {
    startTransition(async () => {
      try {
        await undoWriteOff({ settlementId });
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to undo writeoff";
        console.error("[undoWriteOff]", err);
        window.alert(msg);
      }
    });
  };

  return (
    <>
      <details className="group rounded border border-neutral-200 dark:border-neutral-800">
        <summary className="cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {formatDate(txnDate)} · {txnDescription}
            </div>
            {txnNote && (
              <div className="mt-0.5 text-xs italic text-owed-to-me">
                {txnNote}
              </div>
            )}
            <div
              className={`mt-0.5 text-xs ${splitStatusTone(status)}`}
            >
              {splitStatusLabel(status)} · {settledParticipantCount}/
              {totalParticipantCount} resolved ·{" "}
              <span className="text-neutral-500 group-open:hidden">
                Tap for who owes what
              </span>
            </div>
          </div>
          <div className="text-right font-mono text-sm">
            <div className="text-owed-to-me">
              {formatPaise(outstandingReimbursePaise)} pending
            </div>
            <div className="text-[10px] font-sans text-neutral-500">
              {formatPaise(settledReimbursePaise)} of{" "}
              {formatPaise(expectedReimbursePaise)} resolved
            </div>
          </div>
        </div>
        </summary>

      <div className="border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <div className="mb-2 flex items-center justify-between gap-2 text-xs">
          <span className="text-neutral-500">Who owes what</span>
          <a
            href={transactionHref(txnId)}
            className="underline-offset-2 hover:underline"
          >
            View transaction →
          </a>
        </div>
        <ul className="space-y-2">
          {sorted.map((p) => {
            const paid = p.outstandingPaise === 0;
            return (
              <li
                key={p.participantId}
                className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 rounded bg-neutral-50 px-2 py-1.5 text-sm dark:bg-neutral-900/50"
              >
                <div className="min-w-0">
                  <div className="font-medium">{p.personName}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-neutral-500">
                    {formatPaise(p.settledPaise)} of{" "}
                    {formatPaise(p.expectedPaise)} resolved
                    {(p.bankSettledPaise > 0 ||
                      p.cashSettledPaise > 0 ||
                      p.offsetSettledPaise > 0 ||
                      p.writeoffPaise > 0) && (
                      <span className="font-sans">
                        {" "}
                        (
                        {p.bankSettledPaise > 0 &&
                          `${formatPaise(p.bankSettledPaise)} bank`}
                        {p.bankSettledPaise > 0 &&
                          (p.cashSettledPaise > 0 ||
                            p.offsetSettledPaise > 0 ||
                            p.writeoffPaise > 0) &&
                          " · "}
                        {p.cashSettledPaise > 0 &&
                          `${formatPaise(p.cashSettledPaise)} cash`}
                        {p.cashSettledPaise > 0 &&
                          (p.offsetSettledPaise > 0 || p.writeoffPaise > 0) &&
                          " · "}
                        {p.offsetSettledPaise > 0 &&
                          `${formatPaise(p.offsetSettledPaise)} offset`}
                        {p.offsetSettledPaise > 0 &&
                          p.writeoffPaise > 0 &&
                          " · "}
                        {p.writeoffPaise > 0 &&
                          `${formatPaise(p.writeoffPaise)} forgiven`}
                        )
                      </span>
                    )}
                  </div>
                  {p.writeoffSettlements.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {p.writeoffSettlements.map((w) => (
                        <div
                          key={w.id}
                          className="flex items-center gap-2 text-[10px] text-amber-800 dark:text-amber-400"
                        >
                          <span>
                            {formatPaise(w.amountPaise)} forgiven
                            {w.note ? ` · ${w.note}` : ""}
                          </span>
                          <button
                            type="button"
                            onClick={() => undo(w.id)}
                            disabled={pending}
                            className="text-neutral-500 underline-offset-2 hover:underline disabled:opacity-50"
                          >
                            Undo
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {paid ? (
                    <span className="text-xs text-inflow">Resolved</span>
                  ) : (
                    <>
                      <span className="font-mono text-xs text-owed-to-me">
                        {formatPaise(p.outstandingPaise)} owed
                      </span>
                      <CashSettlementButton
                        splitParticipantId={p.participantId}
                        personName={p.personName}
                        outstandingPaise={p.outstandingPaise}
                        cashSettlements={p.cashSettlements}
                      />
                      <button
                        type="button"
                        onClick={() => forgetIt(p)}
                        disabled={pending}
                        className="rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
                      >
                        Forget it
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      </details>

      <dialog
        ref={forgiveDialogRef}
        onCancel={closeForgiveDialog}
        aria-labelledby="forgive-dialog-title"
        className="w-[min(28rem,calc(100%-2rem))] rounded-lg p-0 backdrop:bg-black/40 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <form
          className="p-5"
          onSubmit={(event) => {
            event.preventDefault();
            confirmForgive();
          }}
        >
          <h3 id="forgive-dialog-title" className="text-base font-semibold">
            Forget this amount?
          </h3>
          {participantToForgive && (
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
              Resolve {formatPaise(participantToForgive.outstandingPaise)} from{" "}
              {participantToForgive.personName} as forgiven. No money will be
              recorded as received.
            </p>
          )}
          <label
            htmlFor={`forgive-reason-${participantToForgive?.participantId ?? "none"}`}
            className="mt-4 block text-xs font-medium text-neutral-700 dark:text-neutral-300"
          >
            Reason (optional)
          </label>
          <textarea
            id={`forgive-reason-${participantToForgive?.participantId ?? "none"}`}
            value={forgiveReason}
            onChange={(event) => setForgiveReason(event.target.value)}
            maxLength={200}
            rows={3}
            autoFocus
            placeholder="For example: They bought me coffee, so we called it even."
            className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-violet-500 dark:border-neutral-700 dark:bg-neutral-950"
          />
          <p className="mt-1 text-right text-[10px] text-neutral-500">
            {forgiveReason.length}/200
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={closeForgiveDialog}
              disabled={pending}
              className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || participantToForgive == null}
              className="rounded bg-amber-700 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {pending ? "Saving…" : "Forgive amount"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
