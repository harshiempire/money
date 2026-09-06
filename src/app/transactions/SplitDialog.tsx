"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { formatPaise } from "@/lib/format";
import {
  formatSettlementResolution,
  type SettlementBreakdown,
} from "@/lib/splits/settlement-breakdown";
import type { SplitSettlementStatus } from "@/lib/splits/settlement-status";
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
  const open = () => dialogRef.current?.showModal();
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

interface DraftParticipant {
  id?: string;
  personName: string;
  expectedRupees: string;
}

const paiseToRupeesStr = (p: number) => (p / 100).toFixed(2);
const rupeesToPaise = (r: string) => Math.round(Number.parseFloat(r) * 100);

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
  const [yourShare, setYourShare] = useState(
    existing ? paiseToRupeesStr(existing.yourSharePaise) : "",
  );
  const [note, setNote] = useState(existing?.note ?? "");
  const [participants, setParticipants] = useState<DraftParticipant[]>(
    existing && existing.participants.length > 0
      ? existing.participants.map((p) => ({
          id: p.id,
          personName: p.personName,
          expectedRupees: paiseToRupeesStr(p.expectedAmountPaise),
        }))
      : [{ personName: "", expectedRupees: "" }],
  );
  const [pending, startTransition] = useTransition();

  // Settled amounts by participant id, for the destructive-edit warning below —
  // the server guard is authoritative, this is just so the user isn't surprised.
  const settledById = new Map(
    (existing?.participants ?? []).map((p) => [p.id, p.settledAmountPaise]),
  );

  // Auto-suggest your_share = total / (1 + participants) when both empty.
  useEffect(() => {
    if (!existing && yourShare === "" && total !== "") {
      const t = Number.parseFloat(total);
      const n = participants.filter((p) => p.personName).length + 1;
      if (n > 1 && Number.isFinite(t)) {
        setYourShare((t / n).toFixed(2));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants.length]);

  const updateParticipant = (i: number, patch: Partial<DraftParticipant>) => {
    setParticipants((arr) => arr.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  };
  const addParticipant = () =>
    setParticipants((arr) => [...arr, { personName: "", expectedRupees: "" }]);
  const removeParticipant = (i: number) => {
    const draft = participants[i];
    const settled = draft.id ? (settledById.get(draft.id) ?? 0) : 0;
    if (settled > 0) {
      const name = draft.personName || "This participant";
      const ok = window.confirm(
        `${name} already has ${formatPaise(settled)} settled against them. The server will refuse to remove them unless that settlement is cleared first. Remove anyway?`,
      );
      if (!ok) return;
    }
    setParticipants((arr) => arr.filter((_, j) => j !== i));
  };

  const equalSplit = () => {
    const totalP = rupeesToPaise(total);
    const named = participants.filter((p) => p.personName.trim());
    const n = named.length + 1;
    if (!Number.isFinite(totalP) || n <= 1) return;
    // Divide in paise and give the indivisible remainder to your own share, so
    // the parts always sum back to the total. Splitting ₹1000 three ways as
    // 333.33 each would leave a paise stranded and trip the balance invariant.
    const base = Math.floor(totalP / n);
    const remainder = totalP - base * n;
    setYourShare(paiseToRupeesStr(base + remainder));
    setParticipants(
      named.map((p) => ({
        id: p.id,
        personName: p.personName,
        expectedRupees: paiseToRupeesStr(base),
      })),
    );
  };

  // Live balance check — mirrors the server's invariant (your share +
  // participants === total) so the Save button can be disabled before the
  // round-trip. Blank "your share" auto-computes as total − participants,
  // same as submit() below, which balances by construction.
  const totalPaiseLive = rupeesToPaise(total);
  const totalValid = Number.isFinite(totalPaiseLive);
  const yourSharePaiseLive =
    yourShare.trim() === "" ? null : rupeesToPaise(yourShare);
  const participantsSumLive = participants
    .filter((p) => p.personName.trim() && p.expectedRupees.trim())
    .reduce((s, p) => {
      const v = rupeesToPaise(p.expectedRupees);
      return s + (Number.isFinite(v) ? v : 0);
    }, 0);
  const effectiveYourSharePaise =
    yourSharePaiseLive != null && Number.isFinite(yourSharePaiseLive)
      ? yourSharePaiseLive
      : totalValid
        ? Math.max(0, totalPaiseLive - participantsSumLive)
        : 0;
  const residualPaise = totalValid
    ? totalPaiseLive - (effectiveYourSharePaise + participantsSumLive)
    : 0;
  const isBalanced = totalValid && residualPaise === 0;

  const submit = () => {
    const cleaned = participants
      .filter((p) => p.personName.trim() && p.expectedRupees.trim())
      .map((p) => ({
        id: p.id,
        personName: p.personName.trim(),
        expectedAmountPaise: rupeesToPaise(p.expectedRupees),
      }));
    const totalPaise = rupeesToPaise(total);
    // If "your share" is left blank, default to total minus sum of named
    // participant shares — i.e. "I paid the rest". Falls back to total when
    // there are no participants, and to 0 if math goes sideways.
    let yourSharePaise = rupeesToPaise(yourShare);
    if (!Number.isFinite(yourSharePaise)) {
      const participantsSum = cleaned.reduce(
        (s, p) => s + p.expectedAmountPaise,
        0,
      );
      yourSharePaise = Number.isFinite(totalPaise)
        ? Math.max(0, totalPaise - participantsSum)
        : 0;
    }
    startTransition(async () => {
      try {
        await createSplit({
          transactionId,
          totalPaise: Number.isFinite(totalPaise) ? totalPaise : 0,
          yourSharePaise,
          note: note.trim() || null,
          participants: cleaned,
        });
        onClose();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to save split";
        console.error("[createSplit]", err);
        window.alert(msg);
      }
    });
  };

  const remove = () => {
    // Deleting a split cascades to its participants and, through them, to their
    // settlements. Unlike an edit (which the server now refuses outright), this
    // is a deliberate act — so spell out exactly what's about to be destroyed
    // rather than silently dropping records of money already received.
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
      try {
        await deleteSplit({ transactionId });
        onClose();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to remove split";
        console.error("[deleteSplit]", err);
        window.alert(msg);
      }
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
        <label className="flex flex-col">
          <span className="text-xs uppercase text-neutral-500">Your share ₹</span>
          <input
            inputMode="decimal"
            value={yourShare}
            placeholder="auto"
            onChange={(e) => setYourShare(e.target.value)}
            className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
          />
          <span className="mt-1 text-[10px] text-neutral-500">
            Leave blank to auto-compute as total − participants.
          </span>
        </label>
      </div>

      <label className="mt-3 flex flex-col text-sm">
        <span className="text-xs uppercase text-neutral-500">Note (optional)</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
        />
      </label>

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
        <div className="mt-2 space-y-2">
          {participants.map((p, i) => {
            const settled = p.id ? (settledById.get(p.id) ?? 0) : 0;
            return (
              <div key={i}>
                <div className="flex items-center gap-2 text-sm">
                  <input
                    placeholder="Name"
                    list="person-names"
                    value={p.personName}
                    onChange={(e) =>
                      updateParticipant(i, { personName: e.target.value })
                    }
                    className="flex-1 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
                  />
                  <input
                    inputMode="decimal"
                    placeholder="₹"
                    value={p.expectedRupees}
                    onChange={(e) =>
                      updateParticipant(i, { expectedRupees: e.target.value })
                    }
                    className="w-24 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
                  />
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
      </div>

      <div className="mt-3 text-xs text-neutral-500">
        Total {formatPaise(totalValid ? totalPaiseLive : 0)} = your share{" "}
        {formatPaise(effectiveYourSharePaise)} + participants{" "}
        {formatPaise(participantsSumLive)}
        {!isBalanced && (
          <span className="ml-1 font-medium text-red-600">
            ({residualPaise >= 0 || !totalValid ? "unaccounted" : "over by"}{" "}
            {formatPaise(Math.abs(residualPaise))})
          </span>
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
            disabled={pending || !isBalanced}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </footer>
    </div>
  );
}
