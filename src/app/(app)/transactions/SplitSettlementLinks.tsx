import { formatDate, formatPaise, counterpartyLabel } from "@/lib/format";
import { LinkedTransactionLink } from "./LinkedTransactionLink";

export type ExpenseLink = {
  expenseTransactionId: string;
  expenseDate: string;
  expenseLabel: string;
  personName: string;
  amountPaise: number;
};

export type ReimbursementLink = {
  inflowTransactionId: string;
  inflowDate: string;
  inflowLabel: string;
  personName: string;
  amountPaise: number;
};

function expenseLabel(
  rawDescription: string,
  parsedPurpose: string | null,
  counterpartyDisplayName: string | null,
): string {
  return (
    parsedPurpose ??
    counterpartyDisplayName ??
    counterpartyLabel(rawDescription) ??
    rawDescription
  );
}

export function buildExpenseLinks(
  rows: Array<{
    inflowTransactionId: string | null;
    amountPaise: number;
    personName: string;
    expenseTransactionId: string;
    expenseTxnDate: string;
    expenseRawDescription: string;
    expenseParsedPurpose: string | null;
    expenseCounterpartyDisplayName: string | null;
  }>,
): Map<string, ExpenseLink[]> {
  const byInflow = new Map<string, ExpenseLink[]>();
  for (const row of rows) {
    if (!row.inflowTransactionId) continue;
    const link: ExpenseLink = {
      expenseTransactionId: row.expenseTransactionId,
      expenseDate: row.expenseTxnDate,
      expenseLabel: expenseLabel(
        row.expenseRawDescription,
        row.expenseParsedPurpose,
        row.expenseCounterpartyDisplayName,
      ),
      personName: row.personName,
      amountPaise: Number(row.amountPaise),
    };
    const arr = byInflow.get(row.inflowTransactionId) ?? [];
    arr.push(link);
    byInflow.set(row.inflowTransactionId, arr);
  }
  return byInflow;
}

export function buildReimbursementLinks(
  rows: Array<{
    splitTransactionId: string;
    inflowTransactionId: string | null;
    amountPaise: number;
    personName: string;
    inflowTxnDate: string;
    inflowRawDescription: string;
    inflowCounterpartyDisplayName: string | null;
  }>,
): Map<string, ReimbursementLink[]> {
  const byExpense = new Map<string, ReimbursementLink[]>();
  for (const row of rows) {
    if (!row.inflowTransactionId) continue;
    const link: ReimbursementLink = {
      inflowTransactionId: row.inflowTransactionId,
      inflowDate: row.inflowTxnDate,
      inflowLabel:
        row.inflowCounterpartyDisplayName ??
        counterpartyLabel(row.inflowRawDescription),
      personName: row.personName,
      amountPaise: Number(row.amountPaise),
    };
    const arr = byExpense.get(row.splitTransactionId) ?? [];
    arr.push(link);
    byExpense.set(row.splitTransactionId, arr);
  }
  return byExpense;
}

export function SplitSettlementLinks({
  expenseLinks,
  reimbursementLinks,
  visibleTxnIds,
}: {
  expenseLinks?: ExpenseLink[];
  reimbursementLinks?: ReimbursementLink[];
  visibleTxnIds: readonly string[];
}) {
  if (
    (!expenseLinks || expenseLinks.length === 0) &&
    (!reimbursementLinks || reimbursementLinks.length === 0)
  ) {
    return null;
  }

  return (
    <div className="mt-1 space-y-0.5 text-[11px] leading-snug">
      {expenseLinks?.map((link) => (
        <div
          key={`${link.expenseTransactionId}-${link.personName}-${link.amountPaise}`}
          className="text-emerald-800/90 dark:text-emerald-300/90"
        >
          <span className="opacity-70">↳</span>{" "}
          <span className="opacity-80">Reimburses</span>{" "}
          <LinkedTransactionLink
            transactionId={link.expenseTransactionId}
            visibleTxnIds={visibleTxnIds}
            className="font-medium underline-offset-2 hover:underline"
            title={`Jump to expense on ${formatDate(link.expenseDate)}`}
          >
            {link.expenseLabel}
          </LinkedTransactionLink>
          <span className="opacity-70">
            {" "}
            · {link.personName} · {formatPaise(link.amountPaise)}
          </span>
        </div>
      ))}
      {reimbursementLinks && reimbursementLinks.length > 0 && (
        <div className="text-violet-800/90 dark:text-violet-300/90">
          <span className="opacity-70">↳</span>{" "}
          <span className="opacity-80">Received</span>{" "}
          {reimbursementLinks.map((link, i) => (
            <span
              key={`${link.inflowTransactionId}-${link.personName}-${link.amountPaise}`}
            >
              {i > 0 && ", "}
              <LinkedTransactionLink
                transactionId={link.inflowTransactionId}
                visibleTxnIds={visibleTxnIds}
                className="font-medium underline-offset-2 hover:underline"
                title={`Jump to ${link.inflowLabel} on ${formatDate(link.inflowDate)}`}
              >
                {formatPaise(link.amountPaise)}
              </LinkedTransactionLink>
              <span className="opacity-70"> from {link.personName}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
