"use client";

import { useRef, useState, useTransition } from "react";
import { deleteCashSettlement, recordCashSettlement } from "./actions";

const paiseToRupeesStr = (p: number) => (p / 100).toFixed(2);
const rupeesToPaise = (r: string) => Math.round(Number.parseFloat(r) * 100);

export interface CashSettlement {
  id: string;
  amountPaise: number;
  note: string | null;
}

export function CashSettlementButton({
  splitParticipantId,
  personName,
  outstandingPaise,
  cashSettlements,
}: {
  splitParticipantId: string;
  personName: string;
  outstandingPaise: number;
  cashSettlements: CashSettlement[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = () => dialogRef.current?.showModal();
  const close = () => dialogRef.current?.close();

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
      >
        Cash...
      </button>
      <dialog
        ref={dialogRef}
        className="rounded-lg p-0 backdrop:bg-black/40 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <CashSettlementForm
          splitParticipantId={splitParticipantId}
          personName={personName}
          outstandingPaise={outstandingPaise}
          cashSettlements={cashSettlements}
          onClose={close}
        />
      </dialog>
    </>
  );
}

function CashSettlementForm({
  splitParticipantId,
  personName,
  outstandingPaise,
  cashSettlements,
  onClose,
}: {
  splitParticipantId: string;
  personName: string;
  outstandingPaise: number;
  cashSettlements: CashSettlement[];
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(paiseToRupeesStr(outstandingPaise));
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  const parsedPaise = rupeesToPaise(amount);
  const isValid = Number.isFinite(parsedPaise) && parsedPaise > 0;

  const submit = () => {
    if (!isValid) return;
    startTransition(async () => {
      await recordCashSettlement({
        splitParticipantId,
        amountPaise: parsedPaise,
        note,
      });
      onClose();
    });
  };

  const remove = (settlementId: string) => {
    startTransition(async () => {
      await deleteCashSettlement({ settlementId });
      onClose();
    });
  };

  return (
    <div className="w-[28rem] max-w-[90vw] p-5">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Record cash settlement</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-neutral-500 hover:underline"
        >
          Close
        </button>
      </header>

      <p className="text-xs text-neutral-500">
        {personName} still owes ₹{paiseToRupeesStr(outstandingPaise)}. Cash
        settlements reduce reimbursement outstanding without changing bank
        transactions.
      </p>

      <div className="mt-4 space-y-3">
        <label className="block text-sm">
          <span className="text-xs uppercase text-neutral-500">Amount</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mt-1 w-full rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
          />
        </label>
        <label className="block text-sm">
          <span className="text-xs uppercase text-neutral-500">Note</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="optional"
            className="mt-1 w-full rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
          />
        </label>
      </div>

      {cashSettlements.length > 0 && (
        <div className="mt-4 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <div className="text-xs uppercase text-neutral-500">Cash recorded</div>
          <div className="mt-2 space-y-2">
            {cashSettlements.map((settlement) => (
              <div
                key={settlement.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <div>
                  <div className="font-mono">
                    ₹{paiseToRupeesStr(settlement.amountPaise)}
                  </div>
                  {settlement.note && (
                    <div className="text-xs text-neutral-500">
                      {settlement.note}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => remove(settlement.id)}
                  disabled={pending}
                  className="text-xs text-red-600 hover:underline disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <footer className="mt-5 flex justify-end gap-2">
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
          disabled={pending || !isValid || outstandingPaise <= 0}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {pending ? "Saving..." : "Save"}
        </button>
      </footer>
    </div>
  );
}
