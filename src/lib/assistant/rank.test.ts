import { describe, expect, test } from "bun:test";
import { rankCandidates, type CandidateRow } from "./rank";
import type { GroundedCriteria } from "./find-intent";

const criteria = (over: Partial<GroundedCriteria>): GroundedCriteria => ({
  amountPaise: null,
  date: null,
  text: null,
  direction: "any",
  dropped: [],
  unreadable: [],
  ...over,
});

const row = (over: Partial<CandidateRow>): CandidateRow => ({
  id: "t",
  txnDate: "2026-08-26",
  amountPaise: 10000,
  drCr: "debit",
  label: "cafe@okaxis",
  counterpartyDisplayName: null,
  channel: "upi",
  rawDescription: "UPI/123/10:00/UPI/cafe@okaxis",
  parsedPurpose: null,
  note: null,
  ...over,
});

const window26 = [{ from: "2026-08-23", to: "2026-08-29", target: "2026-08-26" }];

describe("rankCandidates", () => {
  test("explains an exact amount + date match from the row itself", () => {
    const { ranked, confidence } = rankCandidates(
      criteria({ amountPaise: 10000 }),
      window26,
      [row({ id: "a" })],
    );
    expect(confidence).toBe("single");
    expect(ranked[0].reasons).toEqual([
      "Amount is exactly ₹100.00",
      "Dated 26-08-2026, the day you asked about",
    ]);
  });

  test("closer dates rank first and say how far off they are", () => {
    const { ranked, confidence } = rankCandidates(criteria({ amountPaise: 10000 }), window26, [
      row({ id: "far", txnDate: "2026-08-29" }),
      row({ id: "near", txnDate: "2026-08-27" }),
    ]);
    expect(ranked.map((r) => r.row.id)).toEqual(["near", "far"]);
    expect(ranked[0].reasons[1]).toBe("Dated 27-08-2026, 1 day after 26-08-2026");
    expect(confidence).toBe("ambiguous");
  });

  test("a clearly better match is flagged as the best, not the only", () => {
    const { confidence } = rankCandidates(criteria({ amountPaise: 10000 }), window26, [
      row({ id: "exact" }),
      row({ id: "other", txnDate: "2026-08-29" }),
    ]);
    expect(confidence).toBe("clear_best");
  });

  test("says where search text was found", () => {
    const { ranked } = rankCandidates(criteria({ text: "goa" }), [], [
      row({ note: "Goa trip dinner" }),
    ]);
    expect(ranked[0].reasons).toEqual(['"goa" appears in your note']);
  });

  test("no rows means no confidence", () => {
    expect(rankCandidates(criteria({ amountPaise: 1 }), [], []).confidence).toBe("none");
  });
});
