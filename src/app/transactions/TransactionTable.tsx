import {
  counterpartyLabel,
  formatDate,
  formatPaise,
  formatPaiseSigned,
} from "@/lib/format";
import { RowActions, type CategoryOption } from "./RowActions";
import { SplitSettlementStatusLine } from "./SplitDialog";
import { SplitSettlementLinks } from "./SplitSettlementLinks";
import type { TransactionListRow } from "./load-table-context";
import type { ExistingSplit } from "./SplitDialog";
import type { ExistingAllocation, ParticipantOption } from "./SettleDialog";
import type { ExpenseLink, ReimbursementLink } from "./SplitSettlementLinks";

function ChannelPill({ channel }: { channel: string }) {
  const palette: Record<string, string> = {
    upi: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200",
    imps: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
    neft: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
    rtgs: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
    opening:
      "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  };
  const cls =
    palette[channel] ??
    "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {channel}
    </span>
  );
}

export function TransactionTable({
  rows,
  splitByTxn,
  settlementsByInflow,
  expenseLinksByInflow,
  reimbursementsByExpense,
  participantOptions,
  categoryOptions,
  knownPersonNames,
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
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return <p className="mt-6 text-sm text-neutral-500">{emptyMessage}</p>;
  }

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-neutral-500">
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
                className={`scroll-mt-4 border-t border-neutral-200 align-top dark:border-neutral-800 ${
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
                    categories={categoryOptions}
                    existingSplit={splitByTxn.get(r.id) ?? null}
                    existingSettlement={settlementsByInflow.get(r.id) ?? []}
                    participants={participantOptions}
                    knownPersonNames={knownPersonNames}
                    note={r.note}
                    needsReview={r.needsReview}
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
