"use client";

import { useInvalidateMoneyReads } from "@/lib/query/use-money-query";

import { useRef, useState, useTransition } from "react";
import { flushSync } from "react-dom";
import { useForm, useSelector } from "@tanstack/react-form";
import { formatPaise } from "@/lib/format";
import {
  formatSettlementResolution,
  type SettlementBreakdown,
} from "@/lib/splits/settlement-breakdown";
import type { SplitSettlementStatus } from "@/lib/splits/settlement-status";
import { callAction } from "@/lib/action/result";
import {
  autoSuggestYourShare,
  buildCreateSplitPayload,
  computeSplitBalance,
  equalSplitValues,
  initialSplitFormValues,
  newParticipantRow,
  paiseToRupeesStr,
  splitFormSignature,
  validateSplitForm,
} from "@/lib/splits/split-form";
import { createSplit, deleteSplit } from "./split-actions";

export interface ExistingSplit {
  totalPaise: number;
  yourSharePaise: number;
  note: string | null;
  participants: Array<{
    id: string;
    personName: string;
    expectedAmountPaise: number;
    settledAmountPaise: number;
    outstandingAmountPaise: number;
  }>;
  settlementBreakdown: SettlementBreakdown;
  status: SplitSettlementStatus;
  expectedReimbursePaise: number;
  settledReimbursePaise: number;
  outstandingReimbursePaise: number;
  settledParticipantCount: number;
  totalParticipantCount: number;
}

function splitButtonLabel(existing: ExistingSplit): string {
  const yourShare = (existing.yourSharePaise / 100).toFixed(2);
  switch (existing.status) {
    case "settled":
      return `Split done ✓`;
    case "partial":
      return `Split · partial`;
    case "open":
      return `Split · pending`;
    default:
      return `Split ₹${yourShare}`;
  }
}

function splitButtonTitle(existing: ExistingSplit): string {
  const yourShare = (existing.yourSharePaise / 100).toFixed(2);
  const base = `Split: your share ₹${yourShare}`;
  if (existing.status === "none") return base;
  if (existing.status === "settled") {
    return `${base} · all ${existing.totalParticipantCount} participant${existing.totalParticipantCount === 1 ? "" : "s"} settled`;
  }
  return `${base} · ${existing.settledParticipantCount}/${existing.totalParticipantCount} settled · ${formatPaise(existing.outstandingReimbursePaise)} outstanding`;
}

function splitButtonClass(status: SplitSettlementStatus, hasSplit: boolean): string {
  if (!hasSplit) {
    return "border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800";
  }
  switch (status) {
    case "settled":
      return "border-emerald-400 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300";
    case "partial":
      return "border-amber-400 text-amber-800 dark:border-amber-700 dark:text-amber-300";
    case "open":
      return "border-amber-400 text-amber-800 dark:border-amber-700 dark:text-amber-300";
    default:
      return "border-violet-400 text-violet-700 dark:border-violet-700 dark:text-violet-300";
  }
}

export function SplitSettlementStatusLine({
  split,
}: {
  split: ExistingSplit;
}) {
  if (split.status === "none") return null;

  const settledLabel = formatSettlementResolution({
    status: split.status,
    settledParticipantCount: split.settledParticipantCount,
    totalParticipantCount: split.totalParticipantCount,
    outstandingReimbursePaise: split.outstandingReimbursePaise,
    breakdown: split.settlementBreakdown,
  });

  const tone =
    split.status === "settled"
      ? "text-emerald-700/90 dark:text-emerald-300/90"
      : split.status === "partial"
        ? "text-amber-800/90 dark:text-amber-300/90"
        : "text-amber-800/90 dark:text-amber-300/90";

  return (
    <div className={`mt-0.5 text-[11px] leading-snug ${tone}`}>
      <span className="opacity-70">↳</span>{" "}
      <span className="font-medium">{settledLabel}</span>
    </div>
  );
}


export function SplitButton({
  transactionId,
  amountPaise,
  existing,
  knownPersonNames,
}: {
  transactionId: string;
  amountPaise: number;
  existing: ExistingSplit | null;
  knownPersonNames: string[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const signature = splitFormSignature(existing);
  const [formSnapshot, setFormSnapshot] = useState(() => ({ signature, key: 0 }));
  const open = () => {
    if (dialogRef.current?.open) return;
    // Keep drafts across reopening, but rebuild after a saved split changes.
    // Only opening may remount the form; revalidation must not interrupt edits.
    // flushSync: remount before showModal, so the dialog never opens on (or
    // focuses into) the stale form for a frame.
    if (signature !== formSnapshot.signature) {
      flushSync(() => setFormSnapshot({ signature, key: formSnapshot.key + 1 }));
    }
    dialogRef.current?.showModal();
  };
  const close = () => dialogRef.current?.close();

  return (
    <>
      <button
        type="button"
        onClick={open}
        className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${splitButtonClass(
          existing?.status ?? "none",
          existing != null,
        )}`}
        title={
          existing ? splitButtonTitle(existing) : "Split this transaction"
        }
      >
        {existing ? splitButtonLabel(existing) : "Split"}
      </button>
      <dialog
        ref={dialogRef}
        className="rounded-lg p-0 backdrop:bg-black/40 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <SplitForm
          key={formSnapshot.key}
          transactionId={transactionId}
          amountPaise={amountPaise}
          existing={existing}
          knownPersonNames={knownPersonNames}
          onClose={close}
        />
      </dialog>
    </>
  );
}


function SplitForm({
  transactionId,
  amountPaise,
  existing,
  knownPersonNames,
  onClose,
}: {
  transactionId: string;
  amountPaise: number;
  existing: ExistingSplit | null;
  knownPersonNames: string[];
  onClose: () => void;
}) {
  // The total is the transaction's amount — the server refuses anything else.
  const total = paiseToRupeesStr(amountPaise);
  // Captured once, like the useState initialisers this replaced: a later
  // `existing` from a revalidated page must not reset what is on screen.
  const [defaultValues] = useState(() => initialSplitFormValues(existing));
  const invalidateReads = useInvalidateMoneyReads();
  const [pending, startTransition] = useTransition();

  const form = useForm({
    defaultValues,
    validators: {
      onMount: ({ value }) => validateSplitForm(value, total),
      onChange: ({ value }) => validateSplitForm(value, total),
    },
    onSubmit: async ({ value }) => {
      const input = buildCreateSplitPayload(value, {
        transactionId,
        totalRupees: total,
      });
      const result = await callAction(() => createSplit(input));
      if (result.ok) invalidateReads();
      if (result.ok) onClose();
      else window.alert(result.message);
    },
  });

  const values = useSelector(form.store, (s) => s.values);
  const balanceError = useSelector(form.store, (s) => s.errors[0]);

  const settledById = new Map(
    (existing?.participants ?? []).map((p) => [p.id, p.settledAmountPaise]),
  );

  const suggestYourShare = () => {
    const suggested = autoSuggestYourShare(form.state.values, total, !!existing);
    if (suggested !== null) form.setFieldValue("yourShare", suggested);
  };

  const addParticipant = () => {
    form.pushFieldValue("participants", newParticipantRow());
    suggestYourShare();
  };

  const removeParticipant = (i: number) => {
    const draft = form.state.values.participants[i];
    const settled = draft.id ? (settledById.get(draft.id) ?? 0) : 0;
    if (settled > 0) {
      const name = draft.personName || "This participant";
      const ok = window.confirm(
        `${name} already has ${formatPaise(settled)} settled against them. The server will refuse to remove them unless that settlement is cleared first. Remove anyway?`,
      );
      if (!ok) return;
    }
    void form.removeFieldValue("participants", i);
    suggestYourShare();
  };

  const equalSplit = () => {
    const next = equalSplitValues(form.state.values, total);
    if (!next) return;
    form.setFieldValue("yourShare", next.yourShare);
    form.setFieldValue("participants", next.participants);
  };

  // Live balance line. Save stays disabled while the form-level validator
  // (the same balance rule) reports an error.
  const balance = computeSplitBalance(values, total);

  const submit = () => {
    startTransition(async () => {
      await form.handleSubmit();
    });
  };

  const remove = () => {
    const settledParticipants = (existing?.participants ?? []).filter(
      (p) => p.settledAmountPaise > 0,
    );
    const settledTotal = settledParticipants.reduce(
      (s, p) => s + p.settledAmountPaise,
      0,
    );
    if (settledTotal > 0) {
      const names = settledParticipants
        .map((p) => `${p.personName} (${formatPaise(p.settledAmountPaise)})`)
        .join(", ");
      const ok = window.confirm(
        `Removing this split will also delete ${formatPaise(settledTotal)} of recorded settlements — ${names}. This cannot be undone. Remove anyway?`,
      );
      if (!ok) return;
    }
    startTransition(async () => {
      const result = await callAction(() => deleteSplit({ transactionId }));
      if (result.ok) invalidateReads();
      if (result.ok) onClose();
      else window.alert(result.message);
    });
  };

  return (
    <div className="w-[28rem] max-w-[90vw] p-5">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Split transaction</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-neutral-500 hover:underline"
        >
          Close
        </button>
      </header>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <label className="flex flex-col">
          <span className="text-xs uppercase text-neutral-500">Total ₹</span>
          <input
            inputMode="decimal"
            value={total}
            readOnly
            title="The split total is always the transaction amount"
            className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 text-neutral-500 dark:border-neutral-700"
          />
        </label>
        <form.Field name="yourShare">
          {(field) => (
            <label className="flex flex-col">
              <span className="text-xs uppercase text-neutral-500">Your share ₹</span>
              <input
                inputMode="decimal"
                value={field.state.value}
                placeholder="auto"
                onChange={(e) => field.handleChange(e.target.value)}
                className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
              />
              <span className="mt-1 text-[10px] text-neutral-500">
                Leave blank to auto-compute as total − participants.
              </span>
            </label>
          )}
        </form.Field>
      </div>

      <form.Field name="note">
        {(field) => (
          <label className="mt-3 flex flex-col text-sm">
            <span className="text-xs uppercase text-neutral-500">Note (optional)</span>
            <input
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
            />
          </label>
        )}
      </form.Field>

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase text-neutral-500">Participants</span>
          <button
            type="button"
            onClick={equalSplit}
            className="text-[10px] uppercase tracking-wide text-neutral-500 underline-offset-4 hover:underline"
            title="Divide total equally between you and named participants"
          >
            Equal split
          </button>
        </div>
        <datalist id="person-names">
          {knownPersonNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <form.Field name="participants" mode="array">
          {() => (
            <div className="mt-2 space-y-2">
              {values.participants.map((p, i) => {
                const settled = p.id ? (settledById.get(p.id) ?? 0) : 0;
                return (
                  <div key={i}>
                    <div className="flex items-center gap-2 text-sm">
                      <form.Field name={`participants[${i}].personName`}>
                        {(field) => (
                          <input
                            placeholder="Name"
                            list="person-names"
                            value={field.state.value}
                            onChange={(e) => field.handleChange(e.target.value)}
                            className="flex-1 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
                          />
                        )}
                      </form.Field>
                      <form.Field name={`participants[${i}].expectedRupees`}>
                        {(field) => (
                          <input
                            inputMode="decimal"
                            placeholder="₹"
                            value={field.state.value}
                            onChange={(e) => field.handleChange(e.target.value)}
                            className="w-24 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
                          />
                        )}
                      </form.Field>
                      <button
                        type="button"
                        onClick={() => removeParticipant(i)}
                        className="text-xs text-neutral-500 hover:text-red-600"
                      >
                        ✕
                      </button>
                    </div>
                    {settled > 0 && (
                      <span className="text-[10px] text-amber-700 dark:text-amber-400">
                        {formatPaise(settled)} already settled — editing this row is limited.
                      </span>
                    )}
                  </div>
                );
              })}
              <button
                type="button"
                onClick={addParticipant}
                className="text-xs text-neutral-500 underline-offset-4 hover:underline"
              >
                + Add participant
              </button>
            </div>
          )}
        </form.Field>
      </div>

      <div className="mt-3 text-xs text-neutral-500">
        Total {formatPaise(balance.totalValid ? balance.totalPaise : 0)} = your share{" "}
        {formatPaise(balance.effectiveYourSharePaise)} + participants{" "}
        {formatPaise(balance.participantsSumPaise)}
        {balanceError !== undefined && (
          <span className="ml-1 font-medium text-red-600">({balanceError})</span>
        )}
      </div>

      <footer className="mt-5 flex items-center justify-between">
        {existing ? (
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            className="text-xs text-red-600 hover:underline disabled:opacity-50"
          >
            Remove split
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded px-3 py-1.5 text-sm text-neutral-600 disabled:opacity-50 dark:text-neutral-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending || balanceError !== undefined}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </footer>
    </div>
  );
}
