import { formatDate, formatPaise } from "@/lib/format";
import { transactionHref } from "@/lib/transactions/href";
import type { SplitSettlementStatus } from "@/lib/splits/settlement-status";
import {
  CashSettlementButton,
  type CashSettlement,
} from "./CashSettlementDialog";

export interface SplitParticipantDetail {
  participantId: string;
  personName: string;
  expectedPaise: number;
  settledPaise: number;
  bankSettledPaise: number;
  cashSettledPaise: number;
  outstandingPaise: number;
  cashSettlements: CashSettlement[];
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
      return "All settled";
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
  const sorted = [...participants].sort((a, b) => {
    if (a.outstandingPaise > 0 !== b.outstandingPaise > 0) {
      return a.outstandingPaise > 0 ? -1 : 1;
    }
    return b.outstandingPaise - a.outstandingPaise;
  });

  return (
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
              {totalParticipantCount} paid ·{" "}
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
              {formatPaise(expectedReimbursePaise)} received
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
                    {formatPaise(p.expectedPaise)} received
                    {(p.bankSettledPaise > 0 || p.cashSettledPaise > 0) && (
                      <span className="font-sans">
                        {" "}
                        (
                        {p.bankSettledPaise > 0 &&
                          `${formatPaise(p.bankSettledPaise)} bank`}
                        {p.bankSettledPaise > 0 &&
                          p.cashSettledPaise > 0 &&
                          " · "}
                        {p.cashSettledPaise > 0 &&
                          `${formatPaise(p.cashSettledPaise)} cash`}
                        )
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {paid ? (
                    <span className="text-xs text-inflow">
                      Paid
                    </span>
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
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
