import type { MoneyActor } from "@/lib/assistant/actor-ops";
import type { PeriodTxnMetrics, CategoryRow } from "@/domain/spend/net";
import { mapPeriodMetrics } from "@/domain/spend/period-metrics";
import type { PeriodInput, PeriodSummary } from "./schemas";
import type { OpenShare } from "./overview";
import { resolveMcpPeriod } from "./range";
import { rupees } from "./view";

interface SummaryLoaders {
  metrics(accountId: string, from: string | null, to: string | null, userId: string): Promise<PeriodTxnMetrics>;
  categories(accountId: string, from: string | null, to: string | null, userId: string): Promise<CategoryRow[]>;
  openShares(actor: MoneyActor, input: PeriodInput): Promise<OpenShare[]>;
}

/** Called only after the read adapter verifies the actor's account ownership. */
export async function loadMcpSummary(actor: MoneyActor, input: PeriodInput, load: SummaryLoaders): Promise<PeriodSummary> {
  const period = resolveMcpPeriod(input);
  const [metrics, breakdown, shares] = await Promise.all([
    load.metrics(actor.accountId, period.from, period.to, actor.userId),
    load.categories(actor.accountId, period.from, period.to, actor.userId),
    load.openShares(actor, input),
  ]);
  const { totals, bridge, triage } = mapPeriodMetrics(metrics);
  return {
    period: {
      from: period.from,
      to: period.to,
      label: period.label,
      partial: period.partial,
    },
    open_shares: rupees(shares.reduce((sum, row) => sum + row.outstandingPaise, 0)),
    totals: {
      total_debit: rupees(totals.totalDebitPaise),
      total_credit: rupees(totals.totalCreditPaise),
      net_self: rupees(totals.netSelfPaise),
      owed_self: rupees(totals.owedSelfPaise),
      count: totals.count,
    },
    bridge: {
      personal_debit_gross: rupees(bridge.personalDebitGrossPaise),
      your_share_debit: rupees(bridge.yourShareDebitPaise),
      others_share: rupees(bridge.othersSharePaise),
      net_credit: rupees(bridge.netCreditPaise),
      split_txn_count: bridge.splitTxnCount,
    },
    triage: {
      uncategorized_net_self: rupees(triage.uncategorizedNetSelfPaise),
      uncategorized_count: triage.uncategorizedCount,
      needs_review_count: triage.needsReviewCount,
    },
    categories: breakdown.map((c) => ({
      category: c.categoryName,
      net: rupees(c.netSelfPaise),
      count: c.count,
    })),
  };
}
