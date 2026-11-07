import { describe, expect, test } from "bun:test";
import { buildWaterfallLayout } from "./waterfall-layout";

describe("buildWaterfallLayout", () => {
  test("positions friends bar at the right share of gross", () => {
    const layout = buildWaterfallLayout({
      bridge: {
        personalDebitGrossPaise: 682_40,
        yourShareDebitPaise: 489_30,
        othersSharePaise: 193_10,
        netCreditPaise: 84_00,
        splitTxnCount: 4,
      },
      netSelfPaise: 42_380,
      owedSelfPaise: 1850,
      reimbursement: {
        expectedReimbursePaise: 193_10,
        settledReimbursePaise: 112_00,
        outstandingReimbursePaise: 8110,
        receivedInPeriodPaise: 0,
        outstandingPayablePaise: 0,
        splitCount: 4,
      },
    });
    expect(layout).not.toBeNull();
    const friends = layout!.rows.find((r) => r.key === "friends")!;
    expect(friends.bar[0]!.leftPct).toBeCloseTo(71.7, 0);
    const friendsWidth = friends.bar.reduce((s, b) => s + b.widthPct, 0);
    expect(friendsWidth).toBeCloseTo(28.3, 0);
    const net = layout!.rows.find((r) => r.key === "net")!;
    expect(net.bar[0]!.widthPct).toBeCloseTo(62.1, 0);
  });

  test("returns null when there is nothing to show", () => {
    expect(
      buildWaterfallLayout({
        bridge: {
          personalDebitGrossPaise: 0,
          yourShareDebitPaise: 0,
          othersSharePaise: 0,
          netCreditPaise: 0,
          splitTxnCount: 0,
        },
        netSelfPaise: 0,
        owedSelfPaise: 0,
      }),
    ).toBeNull();
  });
});
