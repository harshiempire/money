import { describe, expect, test } from "bun:test";
import {
  guessPersonFromCounterparty,
  resolveDefaultPersonFilter,
} from "./match-counterparty";

describe("guessPersonFromCounterparty", () => {
  test("matches UPI handle local part to person name", () => {
    expect(
      guessPersonFromCounterparty({
        counterpartyDisplayName: "nitin@okaxis",
        rawDescription: "UPI/123/12:00/UPI/nitin@okaxis",
        knownPersonNames: ["Alice", "Nitin"],
      }),
    ).toBe("Nitin");
  });

  test("matches counterparty display name exactly", () => {
    expect(
      guessPersonFromCounterparty({
        counterpartyDisplayName: "Nitin",
        rawDescription: "IMPS/P2A/123/NITIN KUMAR",
        knownPersonNames: ["Nitin"],
      }),
    ).toBe("Nitin");
  });
});

describe("resolveDefaultPersonFilter", () => {
  test("prefers historical hint over heuristic", () => {
    expect(
      resolveDefaultPersonFilter({
        counterpartyId: "cp-1",
        counterpartyDisplayName: "other@paytm",
        rawDescription: "UPI/1/1/UPI/other@paytm",
        knownPersonNames: ["Nitin"],
        counterpartyPersonHints: { "cp-1": "Nitin" },
      }),
    ).toBe("Nitin");
  });
});
