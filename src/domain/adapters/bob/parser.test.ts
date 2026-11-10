import { describe, expect, test } from "bun:test";
import { extractPeriod, parseBobAppPages } from "./parser";

describe("Bank of Baroda statement period", () => {
  test("parses abbreviated month names from eStatements", () => {
    expect(
      extractPeriod([
        "Statement Period from Jul 01, 2026 to Jul 31, 2026",
      ]),
    ).toEqual({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
  });

  test("continues to parse full month names", () => {
    expect(
      extractPeriod([
        "Statement Period from July 01, 2026 to July 31, 2026",
      ]),
    ).toEqual({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
  });

  test("does not manufacture an invalid date for an unknown month", () => {
    expect(
      extractPeriod([
        "Statement Period from Smarch 01, 2026 to Smarch 31, 2026",
      ]),
    ).toEqual({
      periodStart: null,
      periodEnd: null,
    });
  });
});

describe("bob World app statement", () => {
  const header = "Sr no Transaction date Value date Description Cheque number Debit Credit Balance";
  const footer = [
    "This is a computer-generated statement hence does not require signature.",
    "maintained in the bank containing transactions carried out in normal course of business.",
    "Page 1 of 2",
  ].join("\n");
  const pages = [
    [
      "Account statement from 01 - 09 - 2026 to 30 - 09 - 2026",
      header,
      "1 04 Sep 2026 04 Sep 2026 UPI/100000000001/09:14:40/UPI/samplestore@okbank 1,500.00 - 41,624.78 CR",
      "2 04 Sep 2026 05 Sep 2026 UPI/100000000002/16:41:43/UPI/9000000001@ybl/Foo",
      // The last row of a page can have unrelated page text glued after "CR".
      "d 200.00 - 41,424.78 CRAccount Details",
      "Account holder name",
      "SAMPLE HOLDER 12,345.00 - 99.00 CR",
      footer,
    ].join("\n"),
    [
      header,
      "3 11 Sep 2026 11 Sep 2026 UPI/100000000003/20:53:14/UPI/shop.refunds@okbank - 34.00 41,458.78 CR",
      "4 12 Sep 2026 12 Sep 2026 UPI/100000000004/13:50:40/UPI/9000000002-",
      "2@axl/Ca 128.00 - 41,330.78 CR",
      "5 13 Sep 2026 13 Sep 2026 NEFT-ABCD1234-SAMPLE PAYROLL - 1,00,000.00 1,41,330.78 CR",
      "6 14 Sep 2026 14 Sep 2026 Service charge for a long",
      "description 1,41,331.78 - 1.00 DR",
      footer.replace("1 of 2", "2 of 2"),
    ].join("\n"),
  ];

  test("reads the period written with spaced dashes", () => {
    expect(extractPeriod(pages)).toEqual({ periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  });

  test("parses rows, wrapped descriptions, credits and balances", () => {
    const parsed = parseBobAppPages(pages);
    if (!parsed.ok) throw new Error(parsed.detail);
    expect(parsed.rows.map((r) => [r.txnDate, r.valueDate, r.drCr, r.amountPaise, r.balancePaise])).toEqual([
      ["2026-09-04", "2026-09-04", "debit", 150000, 4162478],
      ["2026-09-04", "2026-09-05", "debit", 20000, 4142478],
      ["2026-09-11", "2026-09-11", "credit", 3400, 4145878],
      ["2026-09-12", "2026-09-12", "debit", 12800, 4133078],
      ["2026-09-13", "2026-09-13", "credit", 10000000, 14133078],
      ["2026-09-14", "2026-09-14", "debit", 14133178, -100],
    ]);
    expect(parsed.rows.map((r) => [r.channel, r.refId, r.counterpartyKey, r.parsedPurpose])).toEqual([
      ["upi", "100000000001", "samplestore@okbank", null],
      ["upi", "100000000002", "9000000001@ybl", "Food"],
      ["upi", "100000000003", "shop.refunds@okbank", null],
      ["upi", "100000000004", "9000000002-2@axl", "Ca"],
      ["neft", "ABCD1234", "SAMPLE PAYROLL", null],
      ["other", null, null, null],
    ]);
    // A wrapped UPI description is rejoined without a space; other text keeps one.
    expect(parsed.rows[1].rawDescription).toBe("UPI/100000000002/16:41:43/UPI/9000000001@ybl/Food");
    expect(parsed.rows[5].rawDescription).toBe("Service charge for a long description");
    expect(parsed.rows[0].rawPayload).toEqual({ serial: 1, balanceText: "41,624.78 CR", format: "bobWorldApp" });
  });

  test("refuses a statement whose balances do not add up", () => {
    const broken = [pages[0], pages[1].replace("- 34.00 41,458.78 CR", "- 34.00 41,468.78 CR")];
    expect(parseBobAppPages(broken)).toEqual({
      ok: false,
      detail: "Sr no 3: the balance does not follow from the previous row",
    });
  });

  test("refuses a row with no amounts instead of swallowing the next one", () => {
    const cut = [pages[1].replace("2@axl/Ca 128.00 - 41,330.78 CR\n", "")];
    expect(parseBobAppPages(cut)).toEqual({
      ok: false,
      detail: "Sr no 4: no amounts found before the next row",
    });
  });
});
