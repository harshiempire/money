"use client";

import { useTransition } from "react";
import {
  applyCategoryToCounterparty,
  setTransactionCategory,
  setTransactionTransfer,
} from "./actions";
import { SplitButton, type ExistingSplit } from "./SplitDialog";
import {
  SettleButton,
  type ExistingAllocation,
  type ParticipantOption,
} from "./SettleDialog";
import { NoteButton } from "./NoteDialog";

export interface CategoryOption {
  id: string;
  name: string;
  kind: "spend" | "transfer" | "reimbursement" | "investment" | "income";
}

export function RowActions({
  transactionId,
  drCr,
  amountPaise,
  categoryId,
  isTransfer,
  counterpartyId,
  categories,
  existingSplit,
  existingSettlement,
  participants,
  note,
}: {
  transactionId: string;
  drCr: "debit" | "credit";
  amountPaise: number;
  categoryId: string | null;
  isTransfer: boolean;
  counterpartyId: string | null;
  categories: CategoryOption[];
  existingSplit: ExistingSplit | null;
  existingSettlement: ExistingAllocation[];
  participants: ParticipantOption[];
  note: string | null;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={categoryId ?? ""}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          startTransition(async () => {
            await setTransactionCategory({
              transactionId,
              categoryId: next,
            });
          });
        }}
        className="rounded border border-neutral-300 bg-transparent px-1.5 py-0.5 text-xs dark:border-neutral-700"
      >
        <option value="">—</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      {categoryId && counterpartyId && (
        <button
          type="button"
          disabled={pending}
          title="Apply this category to all unset transactions from the same counterparty"
          onClick={() => {
            startTransition(async () => {
              await applyCategoryToCounterparty({ transactionId });
            });
          }}
          className="rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          Apply to all
        </button>
      )}

      <label className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500">
        <input
          type="checkbox"
          checked={isTransfer}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            startTransition(async () => {
              await setTransactionTransfer({
                transactionId,
                isTransfer: next,
              });
            });
          }}
        />
        Transfer
      </label>

      {drCr === "debit" && (
        <SplitButton
          transactionId={transactionId}
          amountPaise={amountPaise}
          existing={existingSplit}
        />
      )}
      {drCr === "credit" && (
        <SettleButton
          inflowTransactionId={transactionId}
          amountPaise={amountPaise}
          participants={participants}
          existing={existingSettlement}
        />
      )}

      <NoteButton
        transactionId={transactionId}
        note={note}
        hasCounterparty={counterpartyId !== null}
      />
    </div>
  );
}
