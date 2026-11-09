import { expect, test } from "bun:test";
import { spendWaterfallRows } from "./waterfall";

test("approved waterfall reconciles every intermediate value without double subtracting repayments", () => {
  const rows = spendWaterfallRows(
    {
      personalDebitGrossPaise: 6824000,
      yourShareDebitPaise: 4893000,
      othersSharePaise: 1931000,
      netCreditPaise: 840000,
      splitTxnCount: 4,
    },
    185000,
    4238000,
  );
  expect(rows.map((row) => [row.from, row.to])).toEqual([
    [0, 6824000],
    [6824000, 4893000],
    [4893000, 5078000],
    [5078000, 4238000],
    [0, 4238000],
  ]);
  expect(rows[3].to).toBe(rows[4].to);
});
test("waterfall supports friend-paid-only spend and negative net spend", () => {
  const bridge = {
    personalDebitGrossPaise: 0,
    yourShareDebitPaise: 0,
    othersSharePaise: 0,
    netCreditPaise: 0,
    splitTxnCount: 0,
  };
  expect(spendWaterfallRows(bridge, 125001, 125001)[2].to).toBe(125001);
  const rows = spendWaterfallRows(
    { ...bridge, netCreditPaise: 200001 },
    125001,
    -75000,
  );
  expect(rows[3].to).toBe(-75000);
  expect(rows[4].tone).toBe("inflow");
});
