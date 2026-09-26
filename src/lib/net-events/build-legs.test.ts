import { describe, expect, test } from "bun:test";
import { buildNetLegs } from "./build-legs";
import { validateNetEventInvariant } from "./validate";

describe("buildNetLegs", () => {
  test("the handoff's Nitin example balances against a ₹1,120 inflow", () => {
    const legs = buildNetLegs({
      receivables: [
        { id: "uber", paise: 124000 },
        { id: "creamery", paise: 38000 },
      ],
      payables: [{ id: "movie", paise: 50000 }],
      inflowTransactionId: "credit",
      inflowAmountPaise: 112000,
    });
    expect(legs).toEqual([
      { kind: "receivable", splitParticipantId: "uber", amountPaise: 112000, method: "bank" },
      { kind: "receivable", splitParticipantId: "uber", amountPaise: 12000, method: "offset" },
      { kind: "receivable", splitParticipantId: "creamery", amountPaise: 38000, method: "offset" },
      { kind: "payable", owedExpenseId: "movie", amountPaise: 50000, method: "offset" },
    ]);
    expect(validateNetEventInvariant(legs, 112000, 0)).toEqual({ ok: true });
  });

  test("without an inflow every receivable is an offset", () => {
    const legs = buildNetLegs({
      receivables: [{ id: "r", paise: 500 }],
      payables: [{ id: "p", paise: 500 }],
      inflowTransactionId: undefined,
      inflowAmountPaise: 0,
    });
    expect(legs.map((l) => l.method)).toEqual(["offset", "offset"]);
  });

  test("skips empty lines", () => {
    expect(
      buildNetLegs({
        receivables: [{ id: "r", paise: 0 }],
        payables: [{ id: "p", paise: NaN }],
        inflowTransactionId: "c",
        inflowAmountPaise: 100,
      }),
    ).toEqual([]);
  });
});
