import { describe, expect, test } from "bun:test";
import { rulesIntent } from "./rules-intent";

const TODAY = "2026-09-25";

describe("rulesIntent", () => {
  test("reads the headline example without AI", () => {
    expect(rulesIntent("Show me the transactions for ₹100 from around 26 Aug", TODAY)).toMatchObject({
      kind: "find_transactions",
      amountText: "₹100",
      dateText: "26 Aug",
      textQuery: null,
      direction: "any",
    });
  });

  test("doesn't mistake the day for the amount", () => {
    const r = rulesIntent("100 on 26 Aug", TODAY);
    expect(r.amountText).toBe("100");
    expect(r.dateText).toBe("26 Aug");
  });

  test("picks up a merchant and direction", () => {
    expect(rulesIntent("what did I spend at swiggy in August", TODAY)).toMatchObject({
      dateText: "August",
      textQuery: "swiggy",
      direction: "debit",
    });
    expect(rulesIntent("money I received yesterday", TODAY)).toMatchObject({
      dateText: "yesterday",
      direction: "credit",
    });
  });

  test("leaves ambiguous bare numbers alone", () => {
    expect(rulesIntent("100 or 200", TODAY).amountText).toBeNull();
  });

  test("greetings get help, not a search", () => {
    for (const m of ["hi", "Hi!", "hello", "hey there?", "thanks", "ok"]) {
      const r = rulesIntent(m, TODAY);
      expect(r.kind).toBe("unclear");
      expect(r.question).toContain("₹500");
    }
  });

  test("two-letter leftovers aren't searched", () => {
    expect(rulesIntent("go", TODAY).kind).toBe("unclear");
  });

  test("asks when there is nothing to search by", () => {
    const r = rulesIntent("show me the transactions", TODAY);
    expect(r.kind).toBe("unclear");
    expect(r.question).not.toBeNull();
  });
});
