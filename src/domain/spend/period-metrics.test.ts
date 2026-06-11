import { describe, expect, test } from "bun:test";
import type { PeriodTxnMetrics } from "./net";

/** Maps loadPeriodTxnMetrics to legacy netSpendTotals / splitBridge / triage shapes. */
function mapPeriodMetrics(m: PeriodTxnMetrics) {
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

describe("mapPeriodMetrics", () => {
  test("combines txn net with owed for headline net spend", () => {
    const m: PeriodTxnMetrics = {
      totalDebitPaise: 1000,
      totalCreditPaise: 200,
      txnNetSelfPaise: 800,
      count: 5,
      personalDebitGrossPaise: 1200,
      yourShareDebitPaise: 900,
      othersSharePaise: 300,
      netCreditPaise: 200,
      splitTxnCount: 2,
      uncategorizedNetSelfPaise: 50,
      uncategorizedCount: 1,
      needsReviewCount: 3,
      owedSelfPaise: 100,
    };
    const { totals, bridge, triage } = mapPeriodMetrics(m);
    expect(totals.netSelfPaise).toBe(900);
    expect(bridge.othersSharePaise).toBe(300);
    expect(triage.needsReviewCount).toBe(3);
  });
});
