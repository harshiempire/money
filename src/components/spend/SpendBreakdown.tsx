import { formatPaise } from "@/lib/format";
import type { SplitBridgeTotals } from "@/domain/spend/net";
import type { ReimbursementBridgeTotals } from "@/domain/spend/reimbursements";

export function SpendBreakdown({
  bridge,
  netSelfPaise,
  reimbursement,
  compact = false,
}: {
  bridge: SplitBridgeTotals;
  netSelfPaise: number;
  reimbursement?: ReimbursementBridgeTotals;
  compact?: boolean;
}) {
  if (bridge.personalDebitGrossPaise <= 0 && bridge.netCreditPaise <= 0) {
    return null;
  }

  const splitCount =
    reimbursement?.splitCount ?? bridge.splitTxnCount;

  if (compact) {
    return (
      <dl className="space-y-1 font-mono text-sm">
        <BridgeRow label="Gross debits" value={bridge.personalDebitGrossPaise} />
        {bridge.othersSharePaise > 0 && (
          <BridgeRow
            label="Paid for others"
            value={-bridge.othersSharePaise}
            tone="credit"
          />
        )}
        <BridgeRow label="Your share" value={bridge.yourShareDebitPaise} bold />
        {bridge.netCreditPaise > 0 && (
          <BridgeRow
            label="Refunds & income"
            value={-bridge.netCreditPaise}
            tone="credit"
          />
        )}
        <BridgeRow
          label="Net spend"
          value={netSelfPaise}
          bold
          tone={netSelfPaise >= 0 ? "debit" : "credit"}
        />
        {reimbursement && reimbursement.outstandingReimbursePaise > 0 && (
          <BridgeRow
            label="Still owed to you"
            value={reimbursement.outstandingReimbursePaise}
            tone="credit"
          />
        )}
      </dl>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Debits
        </h3>
        <p className="mt-1 text-xs text-neutral-500">
          Money that left your bank, split into what was yours vs what you paid
          for others.
        </p>
        <dl className="mt-2 space-y-1.5 font-mono text-sm">
          <BridgeRow
            label="Personal debits (gross)"
            value={bridge.personalDebitGrossPaise}
            hint="total from bank"
          />
          {bridge.othersSharePaise > 0 && (
            <BridgeRow
              label="Paid for others"
              value={-bridge.othersSharePaise}
              tone="credit"
              hint={
                splitCount > 0
                  ? `${splitCount} split expense${splitCount === 1 ? "" : "s"}`
                  : undefined
              }
            />
          )}
          <BridgeRow
            label="Your share of debits"
            value={bridge.yourShareDebitPaise}
            bold
            hint="actual consumption"
          />
        </dl>
      </div>

      {reimbursement && reimbursement.expectedReimbursePaise > 0 && (
        <ReimbursementSection reimbursement={reimbursement} />
      )}

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Net
        </h3>
        <p className="mt-1 text-xs text-neutral-500">
          Your true spend after refunds — already uses your share, not gross
          debits. Pending reimbursements are tracked above, not subtracted
          again here.
        </p>
        <dl className="mt-2 space-y-1.5 font-mono text-sm">
          {bridge.netCreditPaise > 0 && (
            <BridgeRow
              label="Refunds & income"
              value={-bridge.netCreditPaise}
              tone="credit"
            />
          )}
          <div className="border-t border-neutral-200 pt-1.5 dark:border-neutral-700">
            <BridgeRow
              label="Net personal spend"
              value={netSelfPaise}
              bold
              tone={netSelfPaise >= 0 ? "debit" : "credit"}
            />
          </div>
        </dl>
      </div>
    </div>
  );
}

function ReimbursementSection({
  reimbursement,
}: {
  reimbursement: ReimbursementBridgeTotals;
}) {
  const {
    expectedReimbursePaise,
    settledReimbursePaise,
    outstandingReimbursePaise,
    receivedInPeriodPaise,
    splitCount,
  } = reimbursement;
  const fullySettled = outstandingReimbursePaise === 0;

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Reimbursements
      </h3>
      <p className="mt-1 text-xs text-neutral-500">
        What others owe for shared expenses this period. Paid back and still
        waiting are two parts of the same total — not extra amounts stacked on
        top of each other.
      </p>

      <div className="mt-3 rounded border border-neutral-200 p-3 dark:border-neutral-800">
        <div className="flex items-baseline justify-between gap-3 font-mono text-sm">
          <span className="font-sans font-medium text-neutral-800 dark:text-neutral-200">
            Others owe you
            <span className="ml-1 font-normal text-neutral-400">
              ({splitCount} split{splitCount === 1 ? "" : "s"})
            </span>
          </span>
          <span className="text-neutral-900 dark:text-neutral-100">
            {formatPaise(expectedReimbursePaise)}
          </span>
        </div>

        <dl className="mt-2 space-y-1 border-l-2 border-neutral-200 pl-3 dark:border-neutral-700">
          {settledReimbursePaise > 0 && (
            <div className="flex items-baseline justify-between gap-3 font-mono text-sm">
              <dt className="font-sans text-[var(--color-text-secondary)]">
                Paid back so far
              </dt>
              <dd className="text-emerald-700 dark:text-emerald-400">
                {formatPaise(settledReimbursePaise)}
              </dd>
            </div>
          )}
          {outstandingReimbursePaise > 0 && (
            <div className="flex items-baseline justify-between gap-3 font-mono text-sm font-semibold">
              <dt className="font-sans text-amber-800 dark:text-amber-300">
                Still waiting
              </dt>
              <dd className="text-amber-700 dark:text-amber-400">
                {formatPaise(outstandingReimbursePaise)}
              </dd>
            </div>
          )}
          {fullySettled && (
            <div className="font-sans text-sm text-emerald-700 dark:text-emerald-400">
              All paid back
            </div>
          )}
        </dl>

        {settledReimbursePaise > 0 && outstandingReimbursePaise > 0 && (
          <p className="mt-2 font-mono text-[11px] text-neutral-500">
            {formatPaise(settledReimbursePaise)} received +{" "}
            {formatPaise(outstandingReimbursePaise)} waiting ={" "}
            {formatPaise(expectedReimbursePaise)} total owed
          </p>
        )}
      </div>

      {receivedInPeriodPaise > 0 && (
          <p className="mt-2 text-xs text-neutral-500">
            <span className="font-mono text-neutral-700 dark:text-neutral-300">
              {formatPaise(receivedInPeriodPaise)}
            </span>{" "}
            received this period — when money actually hit your account (may
            include paybacks for older expenses).
          </p>
        )}
    </div>
  );
}

function BridgeRow({
  label,
  value,
  tone,
  bold,
  hint,
}: {
  label: string;
  value: number;
  tone?: "debit" | "credit";
  bold?: boolean;
  hint?: string;
}) {
  const resolvedTone = tone ?? (value >= 0 ? "debit" : "credit");
  const toneClass =
    resolvedTone === "debit"
      ? "text-[var(--color-debit)]"
      : "text-[var(--color-credit)]";
  const prefix = value < 0 ? "−" : "";
  return (
    <div
      className={`flex items-baseline justify-between gap-3 ${bold ? "font-semibold" : ""}`}
    >
      <dt className="font-sans text-[var(--color-text-secondary)]">
        {label}
        {hint && (
          <span className="ml-1 font-normal text-neutral-400">({hint})</span>
        )}
      </dt>
      <dd className={`whitespace-nowrap ${toneClass}`}>
        {prefix}
        {formatPaise(Math.abs(value))}
      </dd>
    </div>
  );
}
