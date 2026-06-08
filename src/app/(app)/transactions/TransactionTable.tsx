import {
  counterpartyLabel,
  formatDate,
  formatPaise,
  formatPaiseSigned,
} from "@/lib/format";
import { ChannelPill } from "@/components/ui/ChannelPill";
import { EmptyState } from "@/components/ui/EmptyState";
import { RowActions, type CategoryOption } from "./RowActions";
import { SplitSettlementStatusLine } from "./SplitDialog";
import { SplitSettlementLinks } from "./SplitSettlementLinks";
import type { TransactionListRow } from "./load-table-context";
import type { ExistingSplit } from "./SplitDialog";
import type { ExistingAllocation, ParticipantOption } from "./SettleDialog";
import type { ExpenseLink, ReimbursementLink } from "./SplitSettlementLinks";
import type {
  PayableOption,
  ReceivableOption,
  NetEventByTransaction,
} from "@/lib/net-events/load-net-settle-data";

export function TransactionTable({
  rows,
  splitByTxn,
  settlementsByInflow,
  expenseLinksByInflow,
  reimbursementsByExpense,
  participantOptions,
  categoryOptions,
  knownPersonNames,
  counterpartyPersonHints,
  openReceivables,
  openPayables,
  netEventsByTxn,
  emptyMessage,
}: {
  rows: TransactionListRow[];
  splitByTxn: Map<string, ExistingSplit>;
  settlementsByInflow: Map<string, ExistingAllocation[]>;
  expenseLinksByInflow: Map<string, ExpenseLink[]>;
  reimbursementsByExpense: Map<string, ReimbursementLink[]>;
  participantOptions: ParticipantOption[];
  categoryOptions: CategoryOption[];
  knownPersonNames: string[];
  counterpartyPersonHints: Record<string, string>;
  openReceivables: ReceivableOption[];
  openPayables: PayableOption[];
  netEventsByTxn: Map<string, NetEventByTransaction>;
  emptyMessage: string;
}) {
  const visibleTxnIds = rows.map((r) => r.id);

  if (rows.length === 0) {
    return <EmptyState className="mt-6" title={emptyMessage} />;
  }

  return (
    <div className="mt-4 overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border)]">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-overlay)] text-left text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
            <th className="py-2 pr-3">Date</th>
            <th className="py-2 pr-3">Channel</th>
            <th className="py-2 pr-3">Counterparty</th>
            <th className="py-2 pr-3 text-right">Amount</th>
            <th className="py-2 pr-3">Tag</th>
            <th className="py-2 pr-3 text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const expenseLinks = expenseLinksByInflow.get(r.id);
            const reimbursementLinks = reimbursementsByExpense.get(r.id);
            const existingSplit = splitByTxn.get(r.id);
            const isLinked =
              (expenseLinks?.length ?? 0) > 0 ||
              (reimbursementLinks?.length ?? 0) > 0;
            return (
              <tr
                key={r.id}
                id={`txn-${r.id}`}
                className={`scroll-mt-4 border-t border-[var(--color-border)] align-top transition-colors hover:bg-[var(--color-surface-overlay)]/30 ${
                  r.isTransfer ? "opacity-60" : ""
                } ${r.needsReview ? "border-l-2 border-l-amber-400/70 pl-1 dark:border-l-amber-500/60" : ""} ${
                  isLinked
                    ? "border-l-2 border-l-violet-400/60 pl-1 dark:border-l-violet-600/50"
                    : ""
                }`}
              >
                <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                  {formatDate(r.txnDate)}
                </td>
                <td className="py-2 pr-3">
                  <ChannelPill channel={r.channel} />
                </td>
                <td className="py-2 pr-3">
                  <div className="font-medium">
                    {r.counterpartyDisplayName ??
                      counterpartyLabel(r.rawDescription)}
                  </div>
                  {r.parsedPurpose && (
                    <div className="text-xs text-neutral-500">
                      {r.parsedPurpose}
                    </div>
                  )}
                  {r.note && (
                    <div className="mt-0.5 text-xs italic text-amber-700 dark:text-amber-400">
                      {r.note}
                    </div>
                  )}
                  <SplitSettlementLinks
                    expenseLinks={expenseLinks}
                    reimbursementLinks={reimbursementLinks}
                    visibleTxnIds={visibleTxnIds}
                  />
                  {existingSplit && (
                    <SplitSettlementStatusLine split={existingSplit} />
                  )}
                </td>
                <td
                  className={`py-2 pr-3 text-right font-mono whitespace-nowrap ${
                    r.drCr === "debit"
                      ? "text-red-700 dark:text-red-400"
                      : "text-emerald-700 dark:text-emerald-400"
                  }`}
                >
                  {formatPaiseSigned(r.amountPaise, r.drCr)}
                </td>
                <td className="py-2 pr-3">
                  <RowActions
                    transactionId={r.id}
                    drCr={r.drCr}
                    amountPaise={r.amountPaise}
                    categoryId={r.categoryId}
                    isTransfer={r.isTransfer}
                    counterpartyId={r.counterpartyId}
                    counterpartyDisplayName={r.counterpartyDisplayName}
                    rawDescription={r.rawDescription}
                    counterpartyPersonHints={counterpartyPersonHints}
                    categories={categoryOptions}
                    existingSplit={splitByTxn.get(r.id) ?? null}
                    existingSettlement={settlementsByInflow.get(r.id) ?? []}
                    participants={participantOptions}
                    knownPersonNames={knownPersonNames}
                    note={r.note}
                    needsReview={r.needsReview}
                    receivables={openReceivables}
                    payables={openPayables}
                    netEventId={netEventsByTxn.get(r.id)?.netEventId}
                    netEventLegs={netEventsByTxn.get(r.id)?.legs.map((l) => ({
                      kind: l.kind,
                      targetId: l.targetId,
                      amountPaise: l.amountPaise,
                      method:
                        l.method === "bank"
                          ? ("bank" as const)
                          : ("offset" as const),
                    }))}
                    txnDate={r.txnDate}
                  />
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs whitespace-nowrap text-neutral-500">
                  {formatPaise(r.balancePaise)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
