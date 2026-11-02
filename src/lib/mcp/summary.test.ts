import { expect, test } from "bun:test";
import { Schema } from "effect";
import type { PeriodTxnMetrics } from "@/domain/spend/net";
import { loadMcpSummary } from "./summary";
import { SummaryOutput } from "./schemas";

const actor = { accountId: "actor-account", userId: "actor-user" };
const metrics: PeriodTxnMetrics = {
  totalDebitPaise: 1000, totalCreditPaise: 200, txnNetSelfPaise: 500, count: 5,
  personalDebitGrossPaise: 900, yourShareDebitPaise: 700, othersSharePaise: 200,
  netCreditPaise: 200, splitTxnCount: 2, uncategorizedNetSelfPaise: -50,
  uncategorizedCount: 3, needsReviewCount: 1, owedSelfPaise: 100,
};

test("summary defaults to ALL TIME at the loader seam, keeps full names and separates owed from shares", async () => {
  const ranges: unknown[] = [];
  const summary = await loadMcpSummary(actor, {}, {
    async metrics(...args) { ranges.push(args); return metrics; },
    async categories(...args) {
      ranges.push(args);
      return [{ categoryId: "private-db-id", categoryName: "Food@home 123456", netSelfPaise: 600, count: 6 }];
    },
    async openShares(actualActor, input) {
      expect(actualActor).toEqual(actor);
      expect(input).toEqual({});
      return [{ txnDate: "2020-01-01", personName: "Ravi", outstandingPaise: 1 }];
    },
  });
  expect(ranges).toEqual(Array(2).fill([actor.accountId, null, null, actor.userId]));
  expect(summary.period).toEqual({ from: null, to: null, label: "All time", partial: false });
  expect(summary.totals).toEqual({ total_debit: "10.00", total_credit: "2.00", net_self: "6.00", owed_self: "1.00", count: 5 });
  expect(summary.open_shares).toBe("0.01");
  expect(summary.bridge.others_share).toBe("2.00");
  expect(summary.triage).toEqual({ uncategorized_net_self: "-0.50", uncategorized_count: 3, needs_review_count: 1 });
  expect(summary.categories).toEqual([{ category: "Food@home 123456", net: "6.00", count: 6 }]);
  expect(Schema.is(SummaryOutput)(summary)).toBe(true);
  expect(JSON.stringify(summary)).not.toContain("private-db-id");
});

test("summary and list share full month and inclusive custom bounds", async () => {
  for (const [input, from, to] of [
    [{ month: "2026-11" }, "2026-11-01", "2026-11-30"],
    [{ from: "2026-01-15", to: "2026-11-02" }, "2026-01-15", "2026-11-02"],
    [{ to: "2026-11-02" }, null, "2026-11-02"],
  ] as const) {
    const summary = await loadMcpSummary(actor, input, {
      async metrics(accountId, actualFrom, actualTo, userId) {
        expect([accountId, actualFrom, actualTo, userId]).toEqual([actor.accountId, from, to, actor.userId]);
        return metrics;
      },
      async categories() { return []; },
      async openShares() { return []; },
    });
    expect(summary.period).toMatchObject({ from, to });
  }
});
