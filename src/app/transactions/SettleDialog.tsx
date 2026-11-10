"use client";

import Link from "next/link";
import { useInvalidateMoneyReads } from "@/lib/query/use-money-query";

import { useMemo, useRef, useState, useTransition } from "react";
import { formatPaise } from "@/lib/format";
import { parseAllocationInputs } from "@/lib/splits/allocation-input";
import { callAction } from "@/lib/action/result";
import type { SettlementReceipt } from "@/lib/ledger/rules/settlement-policy";
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

export interface CreditResidual {
  acknowledgedPaise: number;
  disposition: "kept" | "written_off" | null;
  overpaymentPayablePaise: number;
  /**
   * Sum of settlement rows on this credit that belong to a Net Settle event.
   * Those rows are not editable here — they only reduce what's left to allocate.
   */
  netSettledPaise: number;
}

const paiseToRupeesStr = (p: number) => (p / 100).toFixed(2);
const rupeesToPaise = (r: string) => Math.round(Number.parseFloat(r) * 100);

const outstandingPaise = (p: ParticipantOption) =>
  Math.max(0, p.expectedAmountPaise - p.alreadySettledPaise);

const ROUND_OFF_THRESHOLD_PAISE = 500;

type ResidualChoice = "owed_back" | "kept" | "written_off";

type SettlementBadgeStatus = "none" | "partial" | "settled" | "over";

function settlementStatus(
  amountPaise: number,
  accountedPaise: number,
): SettlementBadgeStatus {
  if (accountedPaise <= 0) return "none";
  if (accountedPaise < amountPaise) return "partial";
  if (accountedPaise > amountPaise) return "over";
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

// How the credit's leftover was explained, for display next to the badge.
// Only one of these is ever set at a time — recordSettlement clears the
// other before writing a new disposition.
function residualExplanation(
  residual: CreditResidual,
  singlePersonName: string | null,
): string | null {
  if (residual.disposition === "kept" && residual.acknowledgedPaise > 0) {
    return `₹${paiseToRupeesStr(residual.acknowledgedPaise)} kept`;
  }
  if (
    residual.disposition === "written_off" &&
    residual.acknowledgedPaise > 0
  ) {
    return `₹${paiseToRupeesStr(residual.acknowledgedPaise)} written off`;
  }
  if (residual.overpaymentPayablePaise > 0) {
    const suffix = singlePersonName ? ` to ${singlePersonName}` : "";
    return `₹${paiseToRupeesStr(residual.overpaymentPayablePaise)} owed back${suffix}`;
  }
  return null;
}

// The single person these allocations point at, if unambiguous — used both
// to explain an "owed back" residual and to auto-fill the disposition form.
function singleAllocatedPersonName(
  participants: ParticipantOption[],
  existing: ExistingAllocation[],
): string | null {
  const nameById = new Map(participants.map((p) => [p.id, p.personName]));
  const names = new Set(
    existing
      .map((e) => nameById.get(e.splitParticipantId))
      .filter((n): n is string => Boolean(n)),
  );
  return names.size === 1 ? [...names][0] : null;
}

function settleButtonTitle(
  status: SettlementBadgeStatus,
  amountPaise: number,
  allocatedPaise: number,
  remainingPaise: number,
  explanation: string | null,
): string {
  const allocated = `allocated ₹${paiseToRupeesStr(allocatedPaise)} of ₹${paiseToRupeesStr(amountPaise)} credit`;
  switch (status) {
    case "settled":
      return explanation
        ? `Settlement: ${allocated} · ${explanation} · fully settled`
        : `Settlement: ${allocated} · fully settled`;
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
  residual,
}: {
  inflowTransactionId: string;
  amountPaise: number;
  participants: ParticipantOption[];
  existing: ExistingAllocation[];
  residual: CreditResidual;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = () => dialogRef.current?.showModal();
  const close = () => dialogRef.current?.close();
  const [receipt, setReceipt] = useState<SettlementReceipt | null>(null);

  const hasResidualDisposition =
    residual.disposition !== null || residual.overpaymentPayablePaise > 0;
  const isSettlement =
    existing.length > 0 || hasResidualDisposition || residual.netSettledPaise > 0;
  const allocatedPaise =
    existing.reduce((s, e) => s + e.amountPaise, 0) + residual.netSettledPaise;
  const accountedPaise =
    allocatedPaise + residual.acknowledgedPaise + residual.overpaymentPayablePaise;
  const remainingPaise = amountPaise - accountedPaise;
  const status = settlementStatus(amountPaise, accountedPaise);
  const explanation = residualExplanation(
    residual,
    singleAllocatedPersonName(participants, existing),
  );

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={participants.length === 0 && !isSettlement}
        title={
          participants.length === 0 && !isSettlement
            ? "No outstanding split participants — record a split on a debit first"
            : settleButtonTitle(
                status,
                amountPaise,
                allocatedPaise,
                remainingPaise,
                explanation,
              )
        }
        className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${settleButtonClass(status)}`}
      >
        {settleButtonLabel(status, remainingPaise)}
      </button>
      <dialog
        ref={dialogRef}
        onClose={() => setReceipt(null)}
        className="money-dialog p-0 backdrop:bg-black/40"
      >
        {receipt ? (
          <SettleReceipt receipt={receipt} onDone={close} />
        ) : (
          // Remount when saved allocations change, so the form and its guard always match.
          <SettleForm
            key={allocationSignature(existing)}
            inflowTransactionId={inflowTransactionId}
            amountPaise={amountPaise}
            participants={participants}
            existing={existing}
            residual={residual}
            onClose={close}
            onSaved={setReceipt}
          />
        )}
      </dialog>
    </>
  );
}

const DISPOSITION_OPTIONS: Array<{ value: ResidualChoice; label: string }> = [
  { value: "owed_back", label: "They overpaid — I owe them back" },
  { value: "kept", label: "Extra was mine — I'd asked for it" },
  { value: "written_off", label: "Round off — forget it" },
];

const allocationSignature = (rows: ExistingAllocation[]) =>
  rows.map((r) => `${r.splitParticipantId}:${r.amountPaise}`).sort().join(",");

const LEFTOVER_LABEL = {
  owed_back: "owed back",
  kept: "kept",
  written_off: "written off",
} as const;

function SettleReceipt({
  receipt,
  onDone,
}: {
  receipt: SettlementReceipt;
  onDone: () => void;
}) {
  const hasShares = receipt.applied.length > 0;
  return (
    <div className="md w-[32rem] max-w-[90vw]">
      <h2>Settlement saved</h2>
      {hasShares && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {receipt.applied.map((row) => (
            <li key={row.splitParticipantId} className="flex items-baseline justify-between gap-3">
              <span className="font-medium">{row.personName}</span>
              <span className="font-mono text-xs text-neutral-500">
                {formatPaise(row.amountPaise)} applied · {formatPaise(row.leftPaise)} still open
              </span>
            </li>
          ))}
        </ul>
      )}
      <dl className="mt-3 space-y-1 border-t border-neutral-200 pt-3 text-sm dark:border-neutral-800">
        <div className="flex justify-between">
          <dt>Applied from this payment</dt>
          <dd className="font-mono">{formatPaise(receipt.appliedPaise)}</dd>
        </div>
        {hasShares && (
          <div className="flex justify-between">
            <dt>Still open on these shares</dt>
            <dd className="font-mono">{formatPaise(receipt.stillOpenPaise)}</dd>
          </div>
        )}
        {receipt.leftover && (
          <div className="flex justify-between">
            <dt>Leftover {LEFTOVER_LABEL[receipt.leftover.kind]}</dt>
            <dd className="font-mono">{formatPaise(receipt.leftover.paise)}</dd>
          </div>
        )}
        {receipt.unallocatedPaise > 0 && (
          <div className="flex justify-between">
            <dt>Not allocated yet</dt>
            <dd className="font-mono">{formatPaise(receipt.unallocatedPaise)}</dd>
          </div>
        )}
      </dl>
      <footer className="md-footer md-footer-end">
        <button
          type="button"
          onClick={onDone}
          className="gs-primary"
        >
          Done
        </button>
      </footer>
    </div>
  );
}

function SettleForm({
  inflowTransactionId,
  amountPaise,
  participants,
  existing,
  residual,
  onClose,
  onSaved,
}: {
  inflowTransactionId: string;
  amountPaise: number;
  participants: ParticipantOption[];
  existing: ExistingAllocation[];
  residual: CreditResidual;
  onClose: () => void;
  onSaved: (receipt: SettlementReceipt) => void;
}) {
  const initialAllocs: Record<string, string> = Object.fromEntries(
    existing.map((e) => [e.splitParticipantId, paiseToRupeesStr(e.amountPaise)]),
  );
  const [allocations, setAllocations] = useState<Record<string, string>>(
    initialAllocs,
  );
  const [personFilter, setPersonFilter] = useState("");
  const [amountFilter, setAmountFilter] = useState("");
  const invalidateReads = useInvalidateMoneyReads();
  const [pending, startTransition] = useTransition();

  // Net Settle's rows on this credit are fixed: they come off the top and are
  // never part of the editable allocations below.
  const netSettledPaise = residual.netSettledPaise;
  const initialAllocatedPaise = existing.reduce((s, e) => s + e.amountPaise, 0);
  const initialRemaining = amountPaise - netSettledPaise - initialAllocatedPaise;
  const [disposition, setDisposition] = useState<ResidualChoice | null>(() => {
    if (residual.disposition) return residual.disposition;
    if (residual.overpaymentPayablePaise > 0) return "owed_back";
    if (initialRemaining > 0 && initialRemaining <= ROUND_OFF_THRESHOLD_PAISE) {
      return "written_off";
    }
    return null;
  });
  const [owedBackPersonName, setOwedBackPersonName] = useState("");

  const personSuggestions = useMemo(() => {
    const names = new Set(participants.map((p) => p.personName));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [participants]);

  const hasFilters =
    personFilter.trim().length > 0 || amountFilter.trim().length > 0;

  const visible = useMemo(() => {
    return participants.filter((p) => {
      const hasAllocation = Boolean(allocations[p.id]?.trim());
      if (hasAllocation) return true;
      return matchesParticipantFilters(p, personFilter, amountFilter);
    });
  }, [participants, personFilter, amountFilter, allocations]);

  const parsed = useMemo(() => {
    const nameById = new Map(participants.map((p) => [p.id, p.personName]));
    return parseAllocationInputs(
      allocations,
      (id) => nameById.get(id) ?? "This participant",
    );
  }, [allocations, participants]);
  const currentAllocations: ExistingAllocation[] = parsed.allocations;
  const allocatedPaise = currentAllocations.reduce(
    (s, a) => s + a.amountPaise,
    0,
  );
  const remaining = amountPaise - netSettledPaise - allocatedPaise;
  const inputProblem = parsed.problems[0]?.message ?? null;
  const singlePersonName = useMemo(
    () => singleAllocatedPersonName(participants, currentAllocations),
    [participants, currentAllocations],
  );
  const resolvedOwedBackName = singlePersonName || owedBackPersonName.trim();
  const needsOwedBackName =
    disposition === "owed_back" && !resolvedOwedBackName;

  const submit = () => {
    if (!parsed.ok) return;
    startTransition(async () => {
      const result = await callAction(() =>
        recordSettlement({
          inflowTransactionId,
          allocations: currentAllocations,
          expectedAllocations: existing,
          residual: disposition
            ? {
                kind: disposition,
                personName:
                  disposition === "owed_back" ? resolvedOwedBackName : undefined,
                note: null,
              }
            : null,
        }),
      );
      if (result.ok) {
        invalidateReads();
        onSaved(result.data);
      } else window.alert(result.message);
    });
  };

  const remove = () => {
    startTransition(async () => {
      const result = await callAction(() =>
        clearSettlement({ inflowTransactionId }),
      );
      if (result.ok) invalidateReads();
      if (result.ok) onClose();
      else window.alert(result.message);
    });
  };

  return (
    <div className="md w-[32rem] max-w-[90vw]">
      <header className="md-title">
        <h2>Mark as settlement</h2>
        <button
          type="button"
          onClick={onClose}
          className="gs-text-button"
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
        <Link className="underline" href="/reimbursements">
          Reimbursements
        </Link>
        .
      </p>
      {netSettledPaise > 0 && (
        <p className="mt-2 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
          ₹{paiseToRupeesStr(netSettledPaise)} of this credit is already used by
          a Net Settle. That part isn&apos;t editable here — saving or clearing
          below leaves it untouched.
        </p>
      )}

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

      {inputProblem && (
        <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {inputProblem}
        </p>
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
          {paiseToRupeesStr(amountPaise - netSettledPaise)}
          {remaining < 0
            ? ` · over-allocated by ₹${paiseToRupeesStr(-remaining)} — reduce an allocation to save`
            : ` · ₹${paiseToRupeesStr(remaining)} remaining unallocated`}
        </p>
      )}

      {remaining > 0 && (
        <fieldset className="mt-3 space-y-1.5 rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800">
          <legend className="px-1 text-[11px] uppercase tracking-wide text-neutral-500">
            What happened to the {formatPaise(remaining)} left over?
          </legend>
          {DISPOSITION_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2">
              <input
                type="radio"
                name="residual-disposition"
                checked={disposition === opt.value}
                onChange={() => setDisposition(opt.value)}
              />
              {opt.label}
            </label>
          ))}
          {disposition === "owed_back" &&
            (singlePersonName ? (
              <p className="pl-6 text-xs text-neutral-500">
                I owe{" "}
                <span className="font-medium text-neutral-700 dark:text-neutral-300">
                  {singlePersonName}
                </span>{" "}
                {formatPaise(remaining)}.
              </p>
            ) : (
              <div className="pl-6">
                <input
                  type="text"
                  list="settle-person-suggestions"
                  value={owedBackPersonName}
                  onChange={(e) => setOwedBackPersonName(e.target.value)}
                  placeholder="Who do you owe this to?"
                  className="mt-1 w-48 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
                />
              </div>
            ))}
        </fieldset>
      )}

      <footer className="md-footer">
        {existing.length > 0 ||
        residual.disposition !== null ||
        residual.overpaymentPayablePaise > 0 ? (
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            className="md-danger"
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
            className="md-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={
              pending || !parsed.ok || remaining < 0 || needsOwedBackName
            }
            title={
              inputProblem
                ? inputProblem
                : remaining < 0
                  ? "Over-allocated — reduce an allocation before saving"
                  : needsOwedBackName
                    ? "Enter who you owe the overpayment back to"
                    : undefined
            }
            className="gs-primary"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </footer>
    </div>
  );
}
