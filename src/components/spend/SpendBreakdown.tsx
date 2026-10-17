import type { SplitBridgeTotals } from "@/domain/spend/net";
import type { ReimbursementBridgeTotals } from "@/domain/spend/reimbursements";
import { SpendWaterfall } from "./SpendWaterfall";

/**
 * Net-spend waterfall for dashboard and spend report. Replaces the legacy
 * definition-list breakdown.
 */
export function SpendBreakdown({
  bridge,
  netSelfPaise,
  owedSelfPaise = 0,
  reimbursement,
  reportHref,
  className,
}: {
  bridge: SplitBridgeTotals;
  netSelfPaise: number;
  owedSelfPaise?: number;
  reimbursement?: ReimbursementBridgeTotals;
  reportHref?: string;
  className?: string;
}) {
  return (
    <SpendWaterfall
      bridge={bridge}
      netSelfPaise={netSelfPaise}
      owedSelfPaise={owedSelfPaise}
      reimbursement={reimbursement}
      reportHref={reportHref}
      className={className}
    />
  );
}
