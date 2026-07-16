import type {
  NetSpendTotals,
  PeriodTxnMetrics,
  SplitBridgeTotals,
  TriageStats,
} from "./net";

/**
 * Maps loadPeriodTxnMetrics to the legacy netSpendTotals / splitBridge /
 * triage shapes used by the dashboard and spend report pages.
 *
 * This only depends on `net.ts` via type-only imports (erased at compile
 * time) so it stays free of the `server-only` guard on that module and can
 * be unit tested without a server/request context.
 */
export function mapPeriodMetrics(m: PeriodTxnMetrics): {
  totals: NetSpendTotals;
  bridge: SplitBridgeTotals;
  triage: TriageStats;
} {
  return {
    totals: {
      totalDebitPaise: m.totalDebitPaise,
      totalCreditPaise: m.totalCreditPaise,
      netSelfPaise: m.txnNetSelfPaise + m.owedSelfPaise,
      owedSelfPaise: m.owedSelfPaise,
      count: m.count,
    },
    bridge: {
      personalDebitGrossPaise: m.personalDebitGrossPaise,
      yourShareDebitPaise: m.yourShareDebitPaise,
      othersSharePaise: m.othersSharePaise,
      netCreditPaise: m.netCreditPaise,
      splitTxnCount: m.splitTxnCount,
    },
    triage: {
      uncategorizedNetSelfPaise: m.uncategorizedNetSelfPaise,
      uncategorizedCount: m.uncategorizedCount,
      needsReviewCount: m.needsReviewCount,
    },
  };
}
