"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { clearSettlement, recordSettlement } from "./split-actions";

export interface ParticipantOption {
  id: string;
  personName: string;
  expectedAmountPaise: number;
  splitTransactionDate: string;
  splitTransactionDescription: string;
  alreadySettledPaise: number;
}

export interface ExistingAllocation {
  splitParticipantId: string;
  amountPaise: number;
}

const paiseToRupeesStr = (p: number) => (p / 100).toFixed(2);
const rupeesToPaise = (r: string) => Math.round(Number.parseFloat(r) * 100);

const outstandingPaise = (p: ParticipantOption) =>
  Math.max(0, p.expectedAmountPaise - p.alreadySettledPaise);

type SettlementBadgeStatus = "none" | "partial" | "settled" | "over";

function settlementStatus(
  amountPaise: number,
  allocatedPaise: number,
): SettlementBadgeStatus {
  if (allocatedPaise <= 0) return "none";
  if (allocatedPaise < amountPaise) return "partial";
  if (allocatedPaise > amountPaise) return "over";
  return "settled";
}

function settleButtonLabel(
  status: SettlementBadgeStatus,
  remainingPaise: number,
): string {
  switch (status) {
    case "settled":
      return "Settled ✓";
    case "partial":
      return `₹${paiseToRupeesStr(remainingPaise)} LEFT`;
    case "over":
      return `₹${paiseToRupeesStr(-remainingPaise)} OVER`;
    default:
      return "Settle";
  }
}

function settleButtonClass(status: SettlementBadgeStatus): string {
  switch (status) {
    case "settled":
      return "border-emerald-400 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300";
    case "partial":
      return "border-amber-400 text-amber-800 dark:border-amber-700 dark:text-amber-300";
    case "over":
      return "border-red-400 text-red-700 dark:border-red-700 dark:text-red-300";
    default:
      return "border-neutral-300 text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800";
  }
}

function settleButtonTitle(
  status: SettlementBadgeStatus,
  amountPaise: number,
  allocatedPaise: number,
  remainingPaise: number,
): string {
  const allocated = `allocated ₹${paiseToRupeesStr(allocatedPaise)} of ₹${paiseToRupeesStr(amountPaise)} credit`;
  switch (status) {
    case "settled":
      return `Settlement: ${allocated} · fully settled`;
    case "partial":
      return `Settlement: ${allocated} · ₹${paiseToRupeesStr(remainingPaise)} unallocated`;
    case "over":
      return `Settlement: ${allocated} · over-allocated by ₹${paiseToRupeesStr(-remainingPaise)}`;
    default:
      return "Mark this credit as a reimbursement against a split";
  }
}

function matchesParticipantFilters(
  p: ParticipantOption,
  personQuery: string,
  amountQuery: string,
): boolean {
  const nameQ = personQuery.trim().toLowerCase();
  if (nameQ && !p.personName.toLowerCase().includes(nameQ)) {
    return false;
  }
  const amountQ = amountQuery.trim();
  if (!amountQ) return true;

  const targetPaise = rupeesToPaise(amountQ);
  if (!Number.isFinite(targetPaise) || targetPaise < 0) return true;

  const owed = outstandingPaise(p);
  if (owed === targetPaise || p.expectedAmountPaise === targetPaise) {
    return true;
  }
  // Allow typing "661" to match ₹661.50
  const q = amountQ.replace(/[^\d.]/g, "");
  const owedStr = paiseToRupeesStr(owed);
  const expectedStr = paiseToRupeesStr(p.expectedAmountPaise);
  return owedStr.includes(q) || expectedStr.includes(q);
}

export function SettleButton({
  inflowTransactionId,
  amountPaise,
  participants,
  existing,
}: {
  inflowTransactionId: string;
  amountPaise: number;
  participants: ParticipantOption[];
  existing: ExistingAllocation[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = () => dialogRef.current?.showModal();
  const close = () => dialogRef.current?.close();

  const isSettlement = existing.length > 0;
  const allocatedPaise = existing.reduce((s, e) => s + e.amountPaise, 0);
  const remainingPaise = amountPaise - allocatedPaise;
  const status = settlementStatus(amountPaise, allocatedPaise);

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={participants.length === 0 && !isSettlement}
        title={
          participants.length === 0 && !isSettlement
            ? "No outstanding split participants — record a split on a debit first"
            : settleButtonTitle(status, amountPaise, allocatedPaise, remainingPaise)
        }
        className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${settleButtonClass(status)}`}
      >
        {settleButtonLabel(status, remainingPaise)}
      </button>
      <dialog
        ref={dialogRef}
        className="rounded-lg p-0 backdrop:bg-black/40 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <SettleForm
          inflowTransactionId={inflowTransactionId}
          amountPaise={amountPaise}
          participants={participants}
          existing={existing}
          onClose={close}
        />
      </dialog>
    </>
  );
}

function SettleForm({
  inflowTransactionId,
  amountPaise,
  participants,
  existing,
  onClose,
}: {
  inflowTransactionId: string;
  amountPaise: number;
  participants: ParticipantOption[];
  existing: ExistingAllocation[];
  onClose: () => void;
}) {
  const initialAllocs: Record<string, string> = Object.fromEntries(
    existing.map((e) => [e.splitParticipantId, paiseToRupeesStr(e.amountPaise)]),
  );
  const [allocations, setAllocations] = useState<Record<string, string>>(
    initialAllocs,
  );
  const [personFilter, setPersonFilter] = useState("");
  const [amountFilter, setAmountFilter] = useState("");
  const [pending, startTransition] = useTransition();

  const personSuggestions = useMemo(() => {
    const names = new Set(participants.map((p) => p.personName));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [participants]);

  const hasFilters =
    personFilter.trim().length > 0 || amountFilter.trim().length > 0;

  // Rows with an allocation stay visible even when filtered out.
  const visible = useMemo(() => {
    return participants.filter((p) => {
      const hasAllocation = Boolean(allocations[p.id]?.trim());
      if (hasAllocation) return true;
      return matchesParticipantFilters(p, personFilter, amountFilter);
    });
  }, [participants, personFilter, amountFilter, allocations]);

  const allocatedPaise = Object.values(allocations).reduce((s, v) => {
    const n = Number.parseFloat(v);
    return s + (Number.isFinite(n) ? Math.round(n * 100) : 0);
  }, 0);
  const remaining = amountPaise - allocatedPaise;

  const submit = () => {
    const cleaned = Object.entries(allocations)
      .map(([splitParticipantId, rupees]) => ({
        splitParticipantId,
        amountPaise: rupeesToPaise(rupees),
      }))
      .filter((a) => Number.isFinite(a.amountPaise) && a.amountPaise > 0);
    startTransition(async () => {
      try {
        await recordSettlement({
          inflowTransactionId,
          allocations: cleaned,
        });
        onClose();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to save settlement";
        console.error("[recordSettlement]", err);
        window.alert(msg);
      }
    });
  };

  const remove = () => {
    startTransition(async () => {
      try {
        await clearSettlement({ inflowTransactionId });
        onClose();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to clear settlement";
        console.error("[clearSettlement]", err);
        window.alert(msg);
      }
    });
  };

  return (
    <div className="w-[32rem] max-w-[90vw] p-5">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Mark as settlement</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-neutral-500 hover:underline"
        >
          Close
        </button>
      </header>

      <p className="text-xs text-neutral-500">
        Inflow ₹{paiseToRupeesStr(amountPaise)} · attribute to one or more split
        participants.
      </p>
      <p className="mt-1 text-xs text-neutral-500">
        If the person also paid cash, save the bank amount here, then record the
        cash part from{" "}
        <a className="underline" href="/reimbursements">
          Reimbursements
        </a>
        .
      </p>

      {participants.length > 0 && (
        <div className="mt-4 flex flex-wrap items-end gap-2 rounded border border-neutral-200 p-2 dark:border-neutral-800">
          <label className="flex min-w-[8rem] flex-1 flex-col text-xs">
            <span className="uppercase text-neutral-500">Person</span>
            <input
              type="search"
              list="settle-person-suggestions"
              value={personFilter}
              onChange={(e) => setPersonFilter(e.target.value)}
              placeholder="e.g. Shyam"
              className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            />
          </label>
          <label className="flex min-w-[6rem] flex-1 flex-col text-xs">
            <span className="uppercase text-neutral-500">Amount (₹)</span>
            <input
              type="search"
              inputMode="decimal"
              value={amountFilter}
              onChange={(e) => setAmountFilter(e.target.value)}
              placeholder="e.g. 661.50"
              className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            />
          </label>
          {hasFilters && (
            <button
              type="button"
              onClick={() => {
                setPersonFilter("");
                setAmountFilter("");
              }}
              className="rounded px-2 py-1 text-xs text-neutral-500 underline-offset-4 hover:underline"
            >
              Clear filters
            </button>
          )}
          <datalist id="settle-person-suggestions">
            {personSuggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      )}

      {participants.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">
          No split participants exist yet. Create a split on a debit first.
        </p>
      ) : visible.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">
          No lines match these filters. Try another name or amount, or clear
          filters.
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          {hasFilters && (
            <p className="text-[11px] text-neutral-500">
              Showing {visible.length} of {participants.length}
              {Object.values(allocations).some((v) => v.trim()) &&
                " (including rows you already allocated)"}
            </p>
          )}
          {visible.map((p) => {
            const owed = outstandingPaise(p);
            return (
              <div
                key={p.id}
                className="flex items-center gap-2 rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800"
              >
                <div className="flex-1">
                  <div className="font-medium">{p.personName}</div>
                  <div className="text-[11px] text-neutral-500">
                    {p.splitTransactionDate} · {p.splitTransactionDescription} ·
                    expected ₹{paiseToRupeesStr(p.expectedAmountPaise)} ·
                    outstanding ₹{paiseToRupeesStr(owed)}
                  </div>
                </div>
                <input
                  inputMode="decimal"
                  placeholder="₹"
                  value={allocations[p.id] ?? ""}
                  onChange={(e) =>
                    setAllocations((m) => ({ ...m, [p.id]: e.target.value }))
                  }
                  className="w-24 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
                />
                <button
                  type="button"
                  onClick={() =>
                    setAllocations((m) => ({
                      ...m,
                      [p.id]: paiseToRupeesStr(owed),
                    }))
                  }
                  className="text-[10px] uppercase tracking-wide text-neutral-500 underline-offset-4 hover:underline"
                  title="Allocate the outstanding amount"
                >
                  All
                </button>
              </div>
            );
          })}
        </div>
      )}

      {remaining === 0 ? (
        <p className="mt-3 text-xs text-neutral-500">
          Allocated ₹{paiseToRupeesStr(allocatedPaise)} · fully settled
        </p>
      ) : (
        <p
          className={`mt-3 rounded border px-3 py-2 text-sm ${
            remaining < 0
              ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
              : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
          }`}
        >
          Allocated ₹{paiseToRupeesStr(allocatedPaise)} of ₹
          {paiseToRupeesStr(amountPaise)}
          {remaining < 0
            ? ` · over-allocated by ₹${paiseToRupeesStr(-remaining)} — reduce an allocation to save`
            : ` · ₹${paiseToRupeesStr(remaining)} remaining unallocated`}
        </p>
      )}

      <footer className="mt-5 flex items-center justify-between">
        {existing.length > 0 ? (
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            className="text-xs text-red-600 hover:underline disabled:opacity-50"
          >
            Clear settlement
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
            disabled={pending || remaining < 0}
            title={
              remaining < 0
                ? "Over-allocated — reduce an allocation before saving"
                : undefined
            }
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </footer>
    </div>
  );
}
