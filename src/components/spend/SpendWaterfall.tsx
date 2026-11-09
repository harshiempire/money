import Link from "next/link";
import { formatPaise } from "@/lib/format";
import type { SplitBridgeTotals } from "@/domain/spend/net";
import type { ReimbursementBridgeTotals } from "@/domain/spend/reimbursements";
import { spendWaterfallRows } from "@/lib/spend/waterfall";

export function SpendWaterfall({
  bridge,
  netSelfPaise,
  owedSelfPaise = 0,
  reimbursement,
  reportHref,
  compact = false,
}: {
  bridge: SplitBridgeTotals;
  netSelfPaise: number;
  owedSelfPaise?: number;
  reimbursement?: ReimbursementBridgeTotals;
  reportHref?: string;
  compact?: boolean;
}) {
  const rows = spendWaterfallRows(bridge, owedSelfPaise, netSelfPaise);
  const low = Math.min(0, ...rows.flatMap((row) => [row.from, row.to]));
  const high = Math.max(1, ...rows.flatMap((row) => [row.from, row.to]));
  const position = (value: number) =>
    `${((value - low) / (high - low)) * 100}%`;
  const waiting = Math.min(
    bridge.othersSharePaise,
    reimbursement?.spendOutstandingPaise ??
      reimbursement?.outstandingReimbursePaise ??
      bridge.othersSharePaise,
  );
  const paidBack = Math.max(0, bridge.othersSharePaise - waiting);
  return (
    <section
      className={`spend-waterfall ${compact ? "spend-waterfall-compact" : ""}`}
      aria-label="How your personal spend is calculated"
    >
      <header className="spend-waterfall-heading">
        <div>
          <h2>
            How {formatPaise(bridge.personalDebitGrossPaise)} became{" "}
            {formatPaise(netSelfPaise)}
          </h2>
          <p>
            Read top to bottom. Each bar starts where the previous one ended.
          </p>
        </div>
        {reportHref && <Link href={reportHref}>Full spend report →</Link>}
      </header>
      <div className="spend-waterfall-rows">
        {rows.map((row) => (
          <div
            className={`spend-waterfall-row ${row.key === "net" ? "spend-waterfall-total" : ""}`}
            key={row.key}
          >
            <div>
              <h3>{row.label}</h3>
              <p>
                {row.key === "others"
                  ? `Their part of ${bridge.splitTxnCount} split bill${bridge.splitTxnCount === 1 ? "" : "s"}`
                  : row.description}
              </p>
            </div>
            <div>
              <div className="spend-waterfall-track" aria-hidden="true">
                <div
                  className={`spend-waterfall-mark spend-waterfall-${row.tone}`}
                  style={{
                    left: position(Math.min(row.from, row.to)),
                    width: `${(Math.abs(row.to - row.from) / (high - low)) * 100}%`,
                  }}
                >
                  {row.key === "others" && reimbursement ? (
                    <>
                      <span
                        className="spend-waterfall-paid"
                        style={{
                          width: `${bridge.othersSharePaise ? (paidBack / bridge.othersSharePaise) * 100 : 0}%`,
                        }}
                      />
                      <span className="money-hatch" style={{ flex: 1 }} />
                    </>
                  ) : null}
                </div>
              </div>
              {row.key === "others" &&
                reimbursement &&
                bridge.othersSharePaise > 0 && (
                  <div className="spend-waterfall-legend">
                    <span>
                      <i className="spend-waterfall-paid" />
                      {formatPaise(paidBack)} paid back
                    </span>
                    <span>
                      <i className="money-hatch" />
                      {formatPaise(waiting)} still waiting
                    </span>
                  </div>
                )}
            </div>
            <div
              className={`spend-waterfall-value ${row.key === "net" ? (netSelfPaise < 0 ? "text-inflow" : "text-spend") : ""}`}
            >
              {row.delta > 0 && row.key === "owed"
                ? "+"
                : row.delta < 0 && row.key !== "net"
                  ? "−"
                  : ""}
              {formatPaise(
                row.key === "net" ? netSelfPaise : Math.abs(row.delta),
              )}
            </div>
          </div>
        ))}
      </div>
      <details className="spend-waterfall-math">
        <summary>Show the math</summary>
        <div>
          <p className="font-mono">
            {formatPaise(bridge.personalDebitGrossPaise)} −{" "}
            {formatPaise(bridge.othersSharePaise)} ={" "}
            <strong>{formatPaise(bridge.yourShareDebitPaise)}</strong>{" "}
            <span>your share of what you paid</span>
          </p>
          <p className="font-mono">
            {formatPaise(bridge.yourShareDebitPaise)} +{" "}
            {formatPaise(owedSelfPaise)} − {formatPaise(bridge.netCreditPaise)}{" "}
            ={" "}
            <strong className={netSelfPaise < 0 ? "text-inflow" : "text-spend"}>
              {formatPaise(netSelfPaise)}
            </strong>{" "}
            <span>really yours</span>
          </p>
          <p>
            Money friends pay back is not subtracted again — their part was
            already taken out in step 2. Forgiven shares stay in your spend.
          </p>
        </div>
      </details>
    </section>
  );
}
