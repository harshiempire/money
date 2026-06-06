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
import {
  NetSettleButton,
  type NetSettleExistingLeg,
} from "./NetSettleDialog";
import type {
  PayableOption,
  ReceivableOption,
} from "@/lib/net-events/load-net-settle-data";
import { NoteButton } from "./NoteDialog";
import { ReviewLaterButton } from "./ReviewLaterButton";
import { resolveDefaultPersonFilter } from "@/lib/people/match-counterparty";

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
  counterpartyDisplayName,
  rawDescription,
  counterpartyPersonHints,
  categories,
  existingSplit,
  existingSettlement,
  participants,
  knownPersonNames,
  note,
  needsReview,
  receivables,
  payables,
  netEventId,
  netEventLegs,
  txnDate,
}: {
  transactionId: string;
  drCr: "debit" | "credit";
  amountPaise: number;
  categoryId: string | null;
  isTransfer: boolean;
  counterpartyId: string | null;
  counterpartyDisplayName: string | null;
  rawDescription: string;
  counterpartyPersonHints: Record<string, string>;
  categories: CategoryOption[];
  existingSplit: ExistingSplit | null;
  existingSettlement: ExistingAllocation[];
  participants: ParticipantOption[];
  knownPersonNames: string[];
  note: string | null;
  needsReview: boolean;
  receivables: ReceivableOption[];
  payables: PayableOption[];
  netEventId?: string;
  netEventLegs?: NetSettleExistingLeg[];
  txnDate: string;
}) {
  const [pending, startTransition] = useTransition();

  const defaultPersonFilter = resolveDefaultPersonFilter({
    counterpartyId,
    counterpartyDisplayName,
    rawDescription,
    knownPersonNames,
    counterpartyPersonHints,
  });

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
        className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs focus-ring"
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
          className="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-overlay)] disabled:opacity-50"
        >
          Apply to all
        </button>
      )}

      <label className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
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
          knownPersonNames={knownPersonNames}
        />
      )}
      {drCr === "credit" && (
        <>
          <SettleButton
            inflowTransactionId={transactionId}
            amountPaise={amountPaise}
            participants={participants}
            existing={existingSettlement}
          />
          <NetSettleButton
            eventDate={txnDate}
            inflowTransactionId={transactionId}
            inflowAmountPaise={amountPaise}
            receivables={receivables}
            payables={payables}
            categories={categories}
            existingNetEventId={netEventId}
            existingLegs={netEventLegs}
            knownPersonNames={knownPersonNames}
            defaultPersonFilter={defaultPersonFilter}
          />
        </>
      )}
      {drCr === "debit" && (
        <NetSettleButton
          eventDate={txnDate}
          outflowTransactionId={transactionId}
          outflowAmountPaise={amountPaise}
          receivables={receivables}
          payables={payables}
          categories={categories}
          existingNetEventId={netEventId}
          existingLegs={netEventLegs}
          knownPersonNames={knownPersonNames}
          defaultPersonFilter={defaultPersonFilter}
        />
      )}

      <ReviewLaterButton
        transactionId={transactionId}
        needsReview={needsReview}
      />

      <NoteButton
        transactionId={transactionId}
        note={note}
        hasCounterparty={counterpartyId !== null}
      />
    </div>
  );
}
