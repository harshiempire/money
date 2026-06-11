"use client";

import { useId, useMemo, useRef, useState, useTransition } from "react";
import {
  deleteNetEvent,
  saveNetEvent,
  type NetEventLeg,
} from "./net-event-actions";
import type { CategoryOption } from "./RowActions";
import type {
  PayableOption,
  ReceivableOption,
} from "@/lib/net-events/load-net-settle-data";

const paiseToRupeesStr = (p: number) => (p / 100).toFixed(2);
const rupeesToPaise = (r: string) => Math.round(Number.parseFloat(r) * 100);

export interface NetSettleExistingLeg {
  kind: "receivable" | "payable";
  targetId: string;
  amountPaise: number;
  method: "bank" | "offset";
}

function matchesPerson(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q);
}

function buildLegs(
  receivables: ReceivableOption[],
  receivableAllocs: Record<string, string>,
  payables: PayableOption[],
  payableAllocs: Record<string, string>,
  localPayables: PayableOption[],
  inflowTransactionId: string | undefined,
  inflowAmountPaise: number,
): NetEventLeg[] {
  const legs: NetEventLeg[] = [];
  let bankRemaining = inflowAmountPaise;

  for (const r of receivables) {
    const alloc = receivableAllocs[r.id];
    if (!alloc?.trim()) continue;
    let amountPaise = rupeesToPaise(alloc);
    if (amountPaise <= 0) continue;

    if (bankRemaining > 0 && inflowTransactionId) {
      const bankPart = Math.min(amountPaise, bankRemaining);
      legs.push({
        kind: "receivable",
        splitParticipantId: r.id,
        amountPaise: bankPart,
        method: "bank",
      });
      bankRemaining -= bankPart;
      amountPaise -= bankPart;
    }
    if (amountPaise > 0) {
      legs.push({
        kind: "receivable",
        splitParticipantId: r.id,
        amountPaise,
        method: "offset",
      });
    }
  }

  for (const p of payables) {
    const alloc = payableAllocs[p.id];
    if (!alloc?.trim()) continue;
    const amountPaise = rupeesToPaise(alloc);
    if (amountPaise <= 0) continue;
    legs.push({
      kind: "payable",
      owedExpenseId: p.id,
      amountPaise,
      method: "offset",
    });
  }

  for (const p of localPayables) {
    const alloc = payableAllocs[p.id];
    if (!alloc?.trim()) continue;
    const amountPaise = rupeesToPaise(alloc);
    if (amountPaise <= 0) continue;
    legs.push({
      kind: "payable",
      newPayable: {
        personName: p.personName,
        incurredDate: p.incurredDate,
        amountPaise: p.amountPaise,
        description: p.description,
        categoryId: p.categoryId,
      },
      amountPaise,
      method: "offset",
    });
  }

  return legs;
}

export function NetSettleButton({
  eventDate,
  inflowTransactionId,
  outflowTransactionId,
  inflowAmountPaise,
  outflowAmountPaise,
  receivables,
  payables,
  categories,
  existingNetEventId,
  existingLegs,
  defaultPersonFilter,
  knownPersonNames = [],
}: {
  eventDate: string;
  inflowTransactionId?: string;
  outflowTransactionId?: string;
  inflowAmountPaise?: number;
  outflowAmountPaise?: number;
  receivables: ReceivableOption[];
  payables: PayableOption[];
  categories: CategoryOption[];
  existingNetEventId?: string;
  existingLegs?: NetSettleExistingLeg[];
  defaultPersonFilter?: string;
  knownPersonNames?: string[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = () => dialogRef.current?.showModal();
  const close = () => dialogRef.current?.close();

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="shrink-0 whitespace-nowrap rounded border border-violet-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950"
      >
        {existingNetEventId ? "Net ✓" : "Net settle"}
      </button>
      <dialog
        ref={dialogRef}
        className="rounded-lg p-0 backdrop:bg-black/40 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <NetSettleForm
          eventDate={eventDate}
          inflowTransactionId={inflowTransactionId}
          outflowTransactionId={outflowTransactionId}
          inflowAmountPaise={inflowAmountPaise ?? 0}
          outflowAmountPaise={outflowAmountPaise ?? 0}
          receivables={receivables}
          payables={payables}
          categories={categories}
          existingNetEventId={existingNetEventId}
          existingLegs={existingLegs ?? []}
          defaultPersonFilter={defaultPersonFilter ?? ""}
          knownPersonNames={knownPersonNames}
          onClose={close}
        />
      </dialog>
    </>
  );
}

function NetSettleForm({
  eventDate,
  inflowTransactionId,
  outflowTransactionId,
  inflowAmountPaise,
  outflowAmountPaise,
  receivables,
  payables,
  categories,
  existingNetEventId,
  existingLegs,
  defaultPersonFilter,
  knownPersonNames,
  onClose,
}: {
  eventDate: string;
  inflowTransactionId?: string;
  outflowTransactionId?: string;
  inflowAmountPaise: number;
  outflowAmountPaise: number;
  receivables: ReceivableOption[];
  payables: PayableOption[];
  categories: CategoryOption[];
  existingNetEventId?: string;
  existingLegs: NetSettleExistingLeg[];
  defaultPersonFilter: string;
  knownPersonNames: string[];
  onClose: () => void;
}) {
  const personListId = useId();

  const personSuggestions = useMemo(() => {
    const names = new Set<string>(knownPersonNames);
    for (const r of receivables) names.add(r.personName);
    for (const p of payables) names.add(p.personName);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [knownPersonNames, receivables, payables]);
  const initialReceivableAllocs = Object.fromEntries(
    existingLegs
      .filter((l) => l.kind === "receivable")
      .reduce<Map<string, number>>((acc, l) => {
        acc.set(l.targetId, (acc.get(l.targetId) ?? 0) + l.amountPaise);
        return acc;
      }, new Map())
      .entries()
      .map(([id, paise]) => [id, paiseToRupeesStr(paise)]),
  );
  const initialPayableAllocs = Object.fromEntries(
    existingLegs
      .filter((l) => l.kind === "payable")
      .reduce<Map<string, number>>((acc, l) => {
        acc.set(l.targetId, (acc.get(l.targetId) ?? 0) + l.amountPaise);
        return acc;
      }, new Map())
      .entries()
      .map(([id, paise]) => [id, paiseToRupeesStr(paise)]),
  );

  const [receivableAllocs, setReceivableAllocs] = useState<
    Record<string, string>
  >(initialReceivableAllocs);
  const [payableAllocs, setPayableAllocs] =
    useState<Record<string, string>>(initialPayableAllocs);
  const [personFilter, setPersonFilter] = useState(defaultPersonFilter);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [showNewPayable, setShowNewPayable] = useState(false);
  const [newPayable, setNewPayable] = useState({
    personName: defaultPersonFilter,
    incurredDate: eventDate,
    description: "",
    amount: "",
    categoryId: "",
  });
  const [localPayables, setLocalPayables] = useState<PayableOption[]>([]);

  const allPayables = useMemo(
    () => [...payables, ...localPayables],
    [payables, localPayables],
  );

  const visibleReceivables = useMemo(() => {
    return receivables.filter((r) => {
      const hasAlloc = Boolean(receivableAllocs[r.id]?.trim());
      if (hasAlloc) return true;
      return matchesPerson(r.personName, personFilter);
    });
  }, [receivables, personFilter, receivableAllocs]);

  const visiblePayables = useMemo(() => {
    return allPayables.filter((p) => {
      const hasAlloc = Boolean(payableAllocs[p.id]?.trim());
      if (hasAlloc) return true;
      return matchesPerson(p.personName, personFilter);
    });
  }, [allPayables, personFilter, payableAllocs]);

  const receivableTotal = Object.values(receivableAllocs).reduce((s, v) => {
    const n = Number.parseFloat(v);
    return s + (Number.isFinite(n) ? Math.round(n * 100) : 0);
  }, 0);

  const payableTotal = Object.values(payableAllocs).reduce((s, v) => {
    const n = Number.parseFloat(v);
    return s + (Number.isFinite(n) ? Math.round(n * 100) : 0);
  }, 0);

  const netTotal = receivableTotal - payableTotal;
  const expectedNet = inflowAmountPaise - outflowAmountPaise;
  const invariantOk = netTotal === expectedNet;
  const hasNonZeroLeg = receivableTotal > 0 || payableTotal > 0;

  const overAllocationError = useMemo(() => {
    for (const r of receivables) {
      const alloc = receivableAllocs[r.id];
      if (!alloc?.trim()) continue;
      const paise = rupeesToPaise(alloc);
      if (paise > r.outstandingPaise) {
        return `${r.personName} receivable exceeds outstanding`;
      }
    }
    for (const p of allPayables) {
      const alloc = payableAllocs[p.id];
      if (!alloc?.trim()) continue;
      const paise = rupeesToPaise(alloc);
      if (paise > p.outstandingPaise) {
        return `${p.personName} payable exceeds outstanding`;
      }
    }
    return null;
  }, [receivables, allPayables, receivableAllocs, payableAllocs]);

  const addNewPayable = () => {
    const amountPaise = rupeesToPaise(newPayable.amount);
    if (
      !newPayable.personName.trim() ||
      !newPayable.description.trim() ||
      !Number.isFinite(amountPaise) ||
      amountPaise <= 0
    ) {
      setError(
        "Fill person, description, and a positive amount for new payable",
      );
      return;
    }
    const id = `new-${crypto.randomUUID()}`;
    const row: PayableOption = {
      id,
      personName: newPayable.personName.trim(),
      personId: null,
      amountPaise,
      outstandingPaise: amountPaise,
      incurredDate: newPayable.incurredDate,
      description: newPayable.description.trim(),
      categoryId: newPayable.categoryId || null,
    };
    setLocalPayables((prev) => [...prev, row]);
    setPayableAllocs((m) => ({
      ...m,
      [id]: paiseToRupeesStr(amountPaise),
    }));
    setShowNewPayable(false);
    setNewPayable({
      personName: personFilter || defaultPersonFilter,
      incurredDate: eventDate,
      description: "",
      amount: "",
      categoryId: "",
    });
    setError(null);
  };

  const submit = () => {
    setError(null);
    if (overAllocationError) {
      setError(overAllocationError);
      return;
    }
    if (!invariantOk) {
      setError("Net does not match bank delta");
      return;
    }
    if (!hasNonZeroLeg) {
      setError("Add at least one non-zero leg");
      return;
    }

    startTransition(async () => {
      try {
        const legs = buildLegs(
          receivables,
          receivableAllocs,
          payables,
          payableAllocs,
          localPayables,
          inflowTransactionId,
          inflowAmountPaise,
        );

        await saveNetEvent({
          netEventId: existingNetEventId,
          eventDate,
          inflowTransactionId,
          outflowTransactionId,
          note: note.trim() || undefined,
          legs,
        });
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save net event");
      }
    });
  };

  const remove = () => {
    if (!existingNetEventId) return;
    startTransition(async () => {
      await deleteNetEvent({ netEventId: existingNetEventId });
      onClose();
    });
  };

  return (
    <div className="max-h-[90vh] w-[42rem] max-w-[95vw] overflow-y-auto p-5">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Net settle</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-neutral-500 hover:underline"
        >
          Close
        </button>
      </header>

      <p className="text-xs text-neutral-500">
        {inflowTransactionId && (
          <>Inflow ₹{paiseToRupeesStr(inflowAmountPaise)} · </>
        )}
        {outflowTransactionId && (
          <>Outflow ₹{paiseToRupeesStr(outflowAmountPaise)} · </>
        )}
        Expected net ₹{paiseToRupeesStr(expectedNet)}
      </p>

      {defaultPersonFilter.trim() && (
        <p className="mt-2 text-xs text-violet-700 dark:text-violet-300">
          Person filter pre-filled from this transaction&apos;s counterparty.
          Clear it to see all open balances.
        </p>
      )}

      <div className="mt-4">
        <label className="flex flex-col text-xs">
          <span className="uppercase text-neutral-500">Person filter</span>
          <input
            type="search"
            list={personListId}
            value={personFilter}
            onChange={(e) => setPersonFilter(e.target.value)}
            placeholder="e.g. Nitin"
            className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          />
          <datalist id={personListId}>
            {personSuggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <ReceivableSection
          rows={visibleReceivables}
          allocations={receivableAllocs}
          total={receivableTotal}
          onChange={(id, value) =>
            setReceivableAllocs((m) => ({ ...m, [id]: value }))
          }
          onAll={(id, outstanding) =>
            setReceivableAllocs((m) => ({
              ...m,
              [id]: paiseToRupeesStr(outstanding),
            }))
          }
        />

        <PayableSection
          rows={visiblePayables}
          allocations={payableAllocs}
          total={payableTotal}
          onChange={(id, value) =>
            setPayableAllocs((m) => ({ ...m, [id]: value }))
          }
          onAll={(id, outstanding) =>
            setPayableAllocs((m) => ({
              ...m,
              [id]: paiseToRupeesStr(outstanding),
            }))
          }
          showNewPayable={showNewPayable}
          onShowNew={() => {
            setShowNewPayable(true);
            setNewPayable((m) => ({
              ...m,
              personName: personFilter.trim() || m.personName,
            }));
          }}
          onCancelNew={() => setShowNewPayable(false)}
          newPayable={newPayable}
          onNewPayableChange={setNewPayable}
          onAddNew={addNewPayable}
          categories={categories}
          personListId={personListId}
        />
      </div>

      <div className="mt-4 rounded border border-neutral-200 p-3 text-xs dark:border-neutral-800">
        <div>
          Net = Σ receivables − Σ payables = ₹{paiseToRupeesStr(netTotal)}
        </div>
        <div>Expected bank delta = ₹{paiseToRupeesStr(expectedNet)}</div>
        <div
          className={
            invariantOk
              ? "mt-1 text-inflow"
              : "mt-1 text-red-600"
          }
        >
          {invariantOk ? "✓ Balanced" : "✗ Mismatch — adjust allocations"}
        </div>
      </div>

      <label className="mt-3 block text-sm">
        <span className="text-xs uppercase text-neutral-500">Note</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="optional"
          className="mt-1 w-full rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
        />
      </label>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <footer className="mt-5 flex items-center justify-between">
        {existingNetEventId ? (
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            className="text-xs text-red-600 hover:underline disabled:opacity-50"
          >
            Reverse net event
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
            disabled={
              pending ||
              !invariantOk ||
              !hasNonZeroLeg ||
              Boolean(overAllocationError)
            }
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {pending ? "Saving…" : "Save net event"}
          </button>
        </div>
      </footer>
    </div>
  );
}

function ReceivableSection({
  rows,
  allocations,
  total,
  onChange,
  onAll,
}: {
  rows: ReceivableOption[];
  allocations: Record<string, string>;
  total: number;
  onChange: (id: string, value: string) => void;
  onAll: (id: string, outstanding: number) => void;
}) {
  return (
    <section>
      <h3 className="text-sm font-semibold">They owe me</h3>
      <p className="text-[11px] text-neutral-500">
        {rows.length} lines · ₹{paiseToRupeesStr(total)}
      </p>
      <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">
        {rows.map((r) => (
          <AllocationRow
            key={r.id}
            title={r.personName}
            subtitle={`${r.splitTransactionDate} · ${r.splitTransactionDescription} · outstanding ₹${paiseToRupeesStr(r.outstandingPaise)}`}
            value={allocations[r.id] ?? ""}
            onChange={(v) => onChange(r.id, v)}
            onAll={() => onAll(r.id, r.outstandingPaise)}
          />
        ))}
      </div>
    </section>
  );
}

function PayableSection({
  rows,
  allocations,
  total,
  onChange,
  onAll,
  showNewPayable,
  onShowNew,
  onCancelNew,
  newPayable,
  onNewPayableChange,
  onAddNew,
  categories,
  personListId,
}: {
  rows: PayableOption[];
  allocations: Record<string, string>;
  total: number;
  onChange: (id: string, value: string) => void;
  onAll: (id: string, outstanding: number) => void;
  showNewPayable: boolean;
  onShowNew: () => void;
  onCancelNew: () => void;
  newPayable: {
    personName: string;
    incurredDate: string;
    description: string;
    amount: string;
    categoryId: string;
  };
  onNewPayableChange: (v: typeof newPayable) => void;
  onAddNew: () => void;
  categories: CategoryOption[];
  personListId: string;
}) {
  return (
    <section>
      <h3 className="text-sm font-semibold">I owe them</h3>
      <p className="text-[11px] text-neutral-500">
        {rows.length} lines · ₹{paiseToRupeesStr(total)}
      </p>
      <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">
        {rows.map((p) => (
          <AllocationRow
            key={p.id}
            title={p.personName}
            subtitle={`${p.incurredDate} · ${p.description} · outstanding ₹${paiseToRupeesStr(p.outstandingPaise)}`}
            value={allocations[p.id] ?? ""}
            onChange={(v) => onChange(p.id, v)}
            onAll={() => onAll(p.id, p.outstandingPaise)}
          />
        ))}
      </div>
      {!showNewPayable ? (
        <button
          type="button"
          onClick={onShowNew}
          className="mt-2 text-xs text-violet-700 underline dark:text-violet-300"
        >
          + Add new payable
        </button>
      ) : (
        <div className="mt-2 space-y-2 rounded border border-dashed border-neutral-300 p-2 dark:border-neutral-700">
          <input
            type="search"
            list={personListId}
            placeholder="Person"
            value={newPayable.personName}
            onChange={(e) =>
              onNewPayableChange({ ...newPayable, personName: e.target.value })
            }
            className="w-full rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          />
          <input
            placeholder="Description (e.g. biker)"
            value={newPayable.description}
            onChange={(e) =>
              onNewPayableChange({
                ...newPayable,
                description: e.target.value,
              })
            }
            className="w-full rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          />
          <div className="flex gap-2">
            <input
              type="date"
              value={newPayable.incurredDate}
              onChange={(e) =>
                onNewPayableChange({
                  ...newPayable,
                  incurredDate: e.target.value,
                })
              }
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            />
            <input
              inputMode="decimal"
              placeholder="Amount ₹"
              value={newPayable.amount}
              onChange={(e) =>
                onNewPayableChange({ ...newPayable, amount: e.target.value })
              }
              className="w-28 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            />
          </div>
          <select
            value={newPayable.categoryId}
            onChange={(e) =>
              onNewPayableChange({ ...newPayable, categoryId: e.target.value })
            }
            className="w-full rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          >
            <option value="">Category (optional)</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onAddNew}
              className="rounded bg-neutral-900 px-2 py-1 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900"
            >
              Add
            </button>
            <button
              type="button"
              onClick={onCancelNew}
              className="text-xs text-neutral-500"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function AllocationRow({
  title,
  subtitle,
  value,
  onChange,
  onAll,
}: {
  title: string;
  subtitle: string;
  value: string;
  onChange: (value: string) => void;
  onAll: () => void;
}) {
  return (
    <div className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800">
      <div className="font-medium">{title}</div>
      <div className="text-[11px] text-neutral-500">{subtitle}</div>
      <div className="mt-1 flex items-center gap-2">
        <input
          inputMode="decimal"
          placeholder="₹"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-24 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
        />
        <button
          type="button"
          onClick={onAll}
          className="text-[10px] uppercase tracking-wide text-neutral-500 underline-offset-4 hover:underline"
        >
          All
        </button>
      </div>
    </div>
  );
}
