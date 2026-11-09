import { describe, expect, test } from "bun:test";
import {
  guessPersonFromCounterparty,
  resolveDefaultPersonFilter,
} from "./match-counterparty";

describe("guessPersonFromCounterparty", () => {
  test("matches UPI handle local part to person name", () => {
    expect(
      guessPersonFromCounterparty({
        counterpartyDisplayName: "kiran@okaxis",
        rawDescription: "UPI/123/12:00/UPI/kiran@okaxis",
        knownPersonNames: ["Alice", "Kiran"],
      }),
    ).toBe("Kiran");
  });

  test("matches counterparty display name exactly", () => {
    expect(
      guessPersonFromCounterparty({
        counterpartyDisplayName: "Kiran",
        rawDescription: "IMPS/P2A/123/KIRAN KUMAR",
        knownPersonNames: ["Kiran"],
      }),
    ).toBe("Kiran");
  });
});

describe("resolveDefaultPersonFilter", () => {
  test("prefers historical hint over heuristic", () => {
    expect(
      resolveDefaultPersonFilter({
        counterpartyId: "cp-1",
        counterpartyDisplayName: "other@paytm",
        rawDescription: "UPI/1/1/UPI/other@paytm",
        knownPersonNames: ["Kiran"],
        counterpartyPersonHints: { "cp-1": "Kiran" },
      }),
    ).toBe("Kiran");
  });
});
