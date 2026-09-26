import { describe, expect, test } from "bun:test";
import { groundIntent, namedByUser, readFindIntent, type FindIntent } from "./find-intent";

const TODAY = "2026-09-25";

const intent = (over: Partial<FindIntent>): FindIntent => ({
  kind: "find_transactions",
  amountText: null,
  dateText: null,
  textQuery: null,
  direction: "any",
  question: null,
  ...over,
});

describe("readFindIntent", () => {
  test("accepts the schema shape", () => {
    expect(
      readFindIntent({
        kind: "find_transactions",
        amount_text: "₹100",
        date_text: "26 Aug",
        text_query: null,
        direction: "any",
        question: null,
      }),
    ).toEqual(intent({ amountText: "₹100", dateText: "26 Aug" }));
  });

  test("rejects unknown kinds and directions instead of repairing them", () => {
    expect(readFindIntent({ kind: "delete_everything", direction: "any" })).toBeNull();
    expect(readFindIntent({ kind: "find_transactions", direction: "sideways" })).toBeNull();
    expect(readFindIntent("nope")).toBeNull();
    expect(readFindIntent(null)).toBeNull();
  });
});

describe("groundIntent", () => {
  test("drops a year the user never said (the spike's gpt-6-luna case)", () => {
    const g = groundIntent(
      intent({ amountText: "₹100", dateText: "26 Aug 2026" }),
      "Show me the transactions for ₹100 from around 26 Aug",
      TODAY,
    );
    expect(g.amountPaise).toBe(10000);
    expect(g.date).toEqual({ year: null, month: 8, day: 26 });
    expect(g.dropped).toEqual(["year 2026"]);
  });

  test("keeps a year the user did say", () => {
    const g = groundIntent(
      intent({ dateText: "August 26, 2026" }),
      "This happened on August 26, 2026",
      TODAY,
    );
    expect(g.date).toEqual({ year: 2026, month: 8, day: 26 });
    expect(g.dropped).toEqual([]);
  });

  test("accepts a two-digit year only from a numeric date", () => {
    const g = groundIntent(intent({ dateText: "26/8/2026" }), "the one on 26/8/26", TODAY);
    expect(g.date).toEqual({ year: 2026, month: 8, day: 26 });
  });

  test("grounds amounts by value, not spelling", () => {
    const g = groundIntent(intent({ amountText: "₹1,00,000" }), "paid Rs 100000 to the landlord", TODAY);
    expect(g.amountPaise).toBe(10000000);
  });

  test("the day in a date doesn't vouch for an amount", () => {
    const g = groundIntent(intent({ amountText: "₹28", dateText: "28 Aug" }), "categorize the 28 Aug payment", TODAY);
    expect(g.amountPaise).toBeNull();
    expect(g.date).toEqual({ year: null, month: 8, day: 28 });
  });

  test("drops an amount that isn't in the message", () => {
    const g = groundIntent(intent({ amountText: "₹250" }), "show me the swiggy ones", TODAY);
    expect(g.amountPaise).toBeNull();
    expect(g.dropped).toEqual(['amount "₹250"']);
  });

  test("drops search text that isn't in the message", () => {
    const g = groundIntent(intent({ textQuery: "Zomato" }), "the swiggy order", TODAY);
    expect(g.text).toBeNull();
    const ok = groundIntent(intent({ textQuery: "Swiggy" }), "the swiggy order", TODAY);
    expect(ok.text).toBe("Swiggy");
  });

  test("reports spans it can't read exactly", () => {
    const g = groundIntent(
      intent({ amountText: "a hundred", dateText: "last Tuesday" }),
      "a hundred last Tuesday",
      TODAY,
    );
    expect(g.amountPaise).toBeNull();
    expect(g.date).toBeNull();
    expect(g.unreadable).toEqual(["a hundred", "last Tuesday"]);
  });

  test("relative dates resolve on the server, not the model", () => {
    const g = groundIntent(intent({ dateText: "yesterday" }), "what did I spend yesterday", TODAY);
    expect(g.date).toEqual({ year: 2026, month: 9, day: 24 });
  });
});

test("namedByUser: only people the user actually named", () => {
  const said = "Can you find the ₹760 one?\nSplit it between Nitin and me — half each";
  expect(namedByUser("Nitin", said)).toBe(true);
  expect(namedByUser("nitin k", said)).toBe(true);
  expect(namedByUser("Rahul", said)).toBe(false);
  expect(namedByUser("Nitin", "split with nit")).toBe(true);
  expect(namedByUser("", said)).toBe(false);
});
