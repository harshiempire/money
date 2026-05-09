"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createSplit, deleteSplit } from "./split-actions";

export interface ExistingSplit {
  totalPaise: number;
  yourSharePaise: number;
  note: string | null;
  participants: Array<{
    id: string;
    personName: string;
    expectedAmountPaise: number;
  }>;
}

export function SplitButton({
  transactionId,
  amountPaise,
  existing,
}: {
  transactionId: string;
  amountPaise: number;
  existing: ExistingSplit | null;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = () => dialogRef.current?.showModal();
  const close = () => dialogRef.current?.close();

  const yourShareRupees = existing
    ? (existing.yourSharePaise / 100).toFixed(2)
    : null;

  return (
    <>
      <button
        type="button"
        onClick={open}
        className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
          existing
            ? "border-violet-400 text-violet-700 dark:border-violet-700 dark:text-violet-300"
            : "border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
        }`}
        title={
          existing
            ? `Split: your share ₹${yourShareRupees}`
            : "Split this transaction"
        }
      >
        {existing ? `Split ₹${yourShareRupees}` : "Split…"}
      </button>
      <dialog
        ref={dialogRef}
        className="rounded-lg p-0 backdrop:bg-black/40 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <SplitForm
          transactionId={transactionId}
          amountPaise={amountPaise}
          existing={existing}
          onClose={close}
        />
      </dialog>
    </>
  );
}

interface DraftParticipant {
  personName: string;
  expectedRupees: string;
}

const paiseToRupeesStr = (p: number) => (p / 100).toFixed(2);
const rupeesToPaise = (r: string) => Math.round(Number.parseFloat(r) * 100);

function SplitForm({
  transactionId,
  amountPaise,
  existing,
  onClose,
}: {
  transactionId: string;
  amountPaise: number;
  existing: ExistingSplit | null;
  onClose: () => void;
}) {
  const [total, setTotal] = useState(
    existing ? paiseToRupeesStr(existing.totalPaise) : paiseToRupeesStr(amountPaise),
  );
  const [yourShare, setYourShare] = useState(
    existing ? paiseToRupeesStr(existing.yourSharePaise) : "",
  );
  const [note, setNote] = useState(existing?.note ?? "");
  const [participants, setParticipants] = useState<DraftParticipant[]>(
    existing && existing.participants.length > 0
      ? existing.participants.map((p) => ({
          personName: p.personName,
          expectedRupees: paiseToRupeesStr(p.expectedAmountPaise),
        }))
      : [{ personName: "", expectedRupees: "" }],
  );
  const [pending, startTransition] = useTransition();

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
  const removeParticipant = (i: number) =>
    setParticipants((arr) => arr.filter((_, j) => j !== i));

  const equalSplit = () => {
    const t = Number.parseFloat(total);
    const named = participants.filter((p) => p.personName.trim());
    const n = named.length + 1;
    if (!Number.isFinite(t) || n <= 1) return;
    const share = (t / n).toFixed(2);
    setYourShare(share);
    setParticipants(
      named.map((p) => ({ personName: p.personName, expectedRupees: share })),
    );
  };

  const submit = () => {
    const cleaned = participants
      .filter((p) => p.personName.trim() && p.expectedRupees.trim())
      .map((p) => ({
        personName: p.personName.trim(),
        expectedAmountPaise: rupeesToPaise(p.expectedRupees),
      }));
    startTransition(async () => {
      await createSplit({
        transactionId,
        totalPaise: rupeesToPaise(total),
        yourSharePaise: rupeesToPaise(yourShare),
        note: note.trim() || null,
        participants: cleaned,
      });
      onClose();
    });
  };

  const remove = () => {
    startTransition(async () => {
      await deleteSplit({ transactionId });
      onClose();
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
            onChange={(e) => setTotal(e.target.value)}
            className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs uppercase text-neutral-500">Your share ₹</span>
          <input
            inputMode="decimal"
            value={yourShare}
            onChange={(e) => setYourShare(e.target.value)}
            className="mt-1 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
          />
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
        <div className="mt-2 space-y-2">
          {participants.map((p, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <input
                placeholder="Name"
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
          ))}
          <button
            type="button"
            onClick={addParticipant}
            className="text-xs text-neutral-500 underline-offset-4 hover:underline"
          >
            + Add participant
          </button>
        </div>
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
            disabled={pending}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </footer>
    </div>
  );
}
