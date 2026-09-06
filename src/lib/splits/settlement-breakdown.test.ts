import { describe, expect, test } from "bun:test";
import {
  formatSettlementResolution,
  summarizeParticipantSettlements,
} from "./settlement-breakdown";

describe("summarizeParticipantSettlements", () => {
  test("keeps money received, offsets, and forgiveness distinct", () => {
    const result = summarizeParticipantSettlements([
      {
        splitParticipantId: "aryan",
        amountPaise: 1000,
        method: "bank",
      },
      {
        splitParticipantId: "aryan",
        amountPaise: 200,
        method: "cash",
      },
      {
        splitParticipantId: "aryan",
        amountPaise: 300,
        method: "offset",
      },
      {
        splitParticipantId: "aryan",
        amountPaise: 600,
        method: "writeoff",
      },
    ]);

    expect(result.get("aryan")).toEqual({
      totalPaise: 2100,
      breakdown: {
        bankPaise: 1000,
        cashPaise: 200,
        offsetPaise: 300,
        writeoffPaise: 600,
      },
    });
  });
});

describe("formatSettlementResolution", () => {
  test("describes a writeoff as resolved and forgiven, not received", () => {
    expect(
      formatSettlementResolution({
        status: "settled",
        settledParticipantCount: 1,
        totalParticipantCount: 1,
        outstandingReimbursePaise: 0,
        breakdown: {
          bankPaise: 0,
          cashPaise: 0,
          offsetPaise: 0,
          writeoffPaise: 600,
        },
      }),
    ).toBe("Resolved · ₹6.00 forgiven");
  });

  test("describes mixed resolution methods without calling offsets received", () => {
    expect(
      formatSettlementResolution({
        status: "settled",
        settledParticipantCount: 1,
        totalParticipantCount: 1,
        outstandingReimbursePaise: 0,
        breakdown: {
          bankPaise: 1000,
          cashPaise: 500,
          offsetPaise: 250,
          writeoffPaise: 600,
        },
      }),
    ).toBe("Resolved · ₹15.00 received · ₹2.50 offset · ₹6.00 forgiven");
  });
});
