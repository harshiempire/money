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
import type {
  PayableOption,
  ReceivableOption,
  NetEventByTransaction,
} from "@/lib/net-events/load-net-settle-data";

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

function rowAccentClass(
  r: TransactionListRow,
  isLinked: boolean,
): string {
  const parts = [
    r.isTransfer ? "opacity-60" : "",
    r.needsReview
      ? "border-l-2 border-l-amber-400/70 pl-2 dark:border-l-amber-500/60"
      : "",
    isLinked
      ? "border-l-2 border-l-violet-400/60 pl-2 dark:border-l-violet-600/50"
      : "",
  ];
  return parts.filter(Boolean).join(" ");
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
    return <p className="mt-6 text-sm text-neutral-500">{emptyMessage}</p>;
  }

  return (
    <>
      <div className="mt-3 hidden overflow-x-auto md:block">
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
                  className={`scroll-mt-4 border-t border-neutral-200 align-top dark:border-neutral-800 ${rowAccentClass(r, isLinked)}`}
                >
                  <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                    {formatDate(r.txnDate)}
                  </td>
                  <td className="py-2 pr-3">
                    <ChannelPill channel={r.channel} />
                  </td>
                  <td className="py-2 pr-3">
                    <CounterpartyCell
                      r={r}
                      expenseLinks={expenseLinks}
                      reimbursementLinks={reimbursementLinks}
                      existingSplit={existingSplit}
                      visibleTxnIds={visibleTxnIds}
                    />
                  </td>
                  <td
                    className={`py-2 pr-3 text-right font-mono whitespace-nowrap ${
                      r.drCr === "debit" ? "text-spend" : "text-inflow"
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

      <ul className="mt-3 space-y-2 md:hidden">
        {rows.map((r) => {
          const expenseLinks = expenseLinksByInflow.get(r.id);
          const reimbursementLinks = reimbursementsByExpense.get(r.id);
          const existingSplit = splitByTxn.get(r.id);
          const isLinked =
            (expenseLinks?.length ?? 0) > 0 ||
            (reimbursementLinks?.length ?? 0) > 0;
          return (
            <li
              key={r.id}
              id={`txn-${r.id}`}
              className={`scroll-mt-4 rounded border border-neutral-200 p-3 dark:border-neutral-800 ${rowAccentClass(r, isLinked)}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-neutral-500">
                    {formatDate(r.txnDate)}
                  </span>
                  <ChannelPill channel={r.channel} />
                </div>
                <span
                  className={`font-mono text-xs whitespace-nowrap ${
                    r.drCr === "debit" ? "text-spend" : "text-inflow"
                  }`}
                >
                  {formatPaiseSigned(r.amountPaise, r.drCr)}
                </span>
              </div>
              <div className="mt-2 text-sm">
                <CounterpartyCell
                  r={r}
                  expenseLinks={expenseLinks}
                  reimbursementLinks={reimbursementLinks}
                  existingSplit={existingSplit}
                  visibleTxnIds={visibleTxnIds}
                />
              </div>
              <div className="mt-2 flex items-start justify-between gap-2">
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
                <span className="font-mono text-xs whitespace-nowrap text-neutral-500">
                  {formatPaise(r.balancePaise)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function CounterpartyCell({
  r,
  expenseLinks,
  reimbursementLinks,
  existingSplit,
  visibleTxnIds,
}: {
  r: TransactionListRow;
  expenseLinks: ExpenseLink[] | undefined;
  reimbursementLinks: ReimbursementLink[] | undefined;
  existingSplit: ExistingSplit | undefined;
  visibleTxnIds: string[];
}) {
  return (
    <>
      <div className="font-medium">
        {r.counterpartyDisplayName ?? counterpartyLabel(r.rawDescription)}
      </div>
      {r.parsedPurpose && (
        <div className="text-xs text-neutral-500">{r.parsedPurpose}</div>
      )}
      {r.note && (
        <div className="mt-0.5 text-xs italic text-owed-to-me">{r.note}</div>
      )}
      <SplitSettlementLinks
        expenseLinks={expenseLinks}
        reimbursementLinks={reimbursementLinks}
        visibleTxnIds={visibleTxnIds}
      />
      {existingSplit && (
        <SplitSettlementStatusLine split={existingSplit} />
      )}
    </>
  );
}
