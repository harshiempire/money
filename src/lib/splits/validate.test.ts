import { describe, expect, test } from "bun:test";
import {
  validateAllocationAmounts,
  validateNoDuplicateParticipants,
  validatePayableReplaceable,
  validateSettlementSource,
  validateSplitAmounts,
  validateSplitBalances,
  validateSplitInput,
} from "./validate";

const p = (
  expectedAmountPaise: number,
  personName = "Someone",
  id?: string,
) => ({ id, personName, expectedAmountPaise });

describe("validateSplitBalances", () => {
  test("accepts a split whose parts sum to the total", () => {
    expect(
      validateSplitBalances({
        totalPaise: 364900,
        yourSharePaise: 121633,
        participants: [p(121633, "Nitin"), p(121634, "Rishith")],
      }).ok,
    ).toBe(true);
  });

  test("rejects the paise stranded by an equal three-way split", () => {
    // 1000 / 3 = 333.33 each; the parts fall a paise short of the total.
    const r = validateSplitBalances({
      totalPaise: 100000,
      yourSharePaise: 33333,
      participants: [p(33333), p(33333)],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("₹0.01 unaccounted");
  });

  test("reports the shortfall when your share was never corrected", () => {
    // The BookMyShow shape: a participant carries the whole amount and your
    // share was left behind, so the parts exceed the transaction.
    const r = validateSplitBalances({
      totalPaise: 28304,
      yourSharePaise: 14152,
      participants: [p(28304)],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("₹141.52 unaccounted");
  });
});

describe("validateSplitAmounts — negative amounts (finding 5)", () => {
  test("rejects a negative participant share that would otherwise balance", () => {
    // total 100 = your 200 + participant (−100): balances, but inflates your
    // recorded spend to twice the transaction.
    const input = {
      totalPaise: 10000,
      yourSharePaise: 20000,
      participants: [p(-10000, "Ghost")],
    };
    expect(validateSplitBalances(input).ok).toBe(true);
    const r = validateSplitAmounts(input);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("Ghost");
  });

  test("rejects a negative total and a negative your-share", () => {
    expect(
      validateSplitAmounts({
        totalPaise: -1,
        yourSharePaise: 0,
        participants: [],
      }).ok,
    ).toBe(false);
    expect(
      validateSplitAmounts({
        totalPaise: 100,
        yourSharePaise: -100,
        participants: [],
      }).ok,
    ).toBe(false);
  });

  test("rejects fractional paise", () => {
    expect(
      validateSplitAmounts({
        totalPaise: 100.5,
        yourSharePaise: 100.5,
        participants: [],
      }).ok,
    ).toBe(false);
  });

  test("validateSplitInput catches sign before it reports a balance error", () => {
    const r = validateSplitInput({
      totalPaise: 10000,
      yourSharePaise: 20000,
      participants: [p(-10000, "Ghost")],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).not.toContain("balance");
  });
});

describe("validateNoDuplicateParticipants — collapsing ids (finding 4)", () => {
  test("rejects the same participant id twice even when the split balances", () => {
    // {P, ₹50} + {P, ₹30} sums to ₹80 and balances against total ₹100 /
    // your ₹20, but the write path keys on id, so only ₹30 survives.
    const input = {
      totalPaise: 10000,
      yourSharePaise: 2000,
      participants: [p(5000, "Nitin", "P"), p(3000, "Nitin", "P")],
    };
    expect(validateSplitBalances(input).ok).toBe(true);
    const r = validateNoDuplicateParticipants(input.participants);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("Nitin");
  });

  test("allows repeated names as long as the ids differ", () => {
    expect(
      validateNoDuplicateParticipants([
        p(100, "Nitin", "a"),
        p(100, "Nitin", "b"),
      ]).ok,
    ).toBe(true);
  });

  test("allows several brand-new participants, which carry no id", () => {
    expect(
      validateNoDuplicateParticipants([p(100, "A"), p(100, "B"), p(100, "C")])
        .ok,
    ).toBe(true);
  });
});

describe("validateSettlementSource — debit as inflow (finding 3)", () => {
  test("rejects a debit", () => {
    const r = validateSettlementSource("debit");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("money arriving");
  });

  test("rejects a missing transaction", () => {
    expect(validateSettlementSource(null).ok).toBe(false);
    expect(validateSettlementSource(undefined).ok).toBe(false);
  });

  test("accepts a credit", () => {
    expect(validateSettlementSource("credit").ok).toBe(true);
  });
});

describe("validateAllocationAmounts", () => {
  test("rejects a negative allocation", () => {
    expect(
      validateAllocationAmounts([
        { splitParticipantId: "a", amountPaise: 100 },
        { splitParticipantId: "b", amountPaise: -100 },
      ]).ok,
    ).toBe(false);
  });

  test("accepts positive allocations", () => {
    expect(
      validateAllocationAmounts([{ splitParticipantId: "a", amountPaise: 100 }])
        .ok,
    ).toBe(true);
  });
});

describe("validatePayableReplaceable — repaid overpayment (finding 1)", () => {
  test("refuses to replace a leftover whose payable was already repaid", () => {
    const r = validatePayableReplaceable({
      personName: "Aryan",
      settledPaise: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("Aryan");
    expect(r.ok === false && r.message).toContain("₹20.00");
  });

  test("allows replacing an untouched payable", () => {
    expect(
      validatePayableReplaceable({ personName: "Aryan", settledPaise: 0 }).ok,
    ).toBe(true);
  });
});

// ── Codex merge-readiness review (thread 01a039f6), 2026-08-26 ──────────────

import {
  cleanAllocations,
  validateInflowCapacity,
  validateParticipantIdsBelongToSplit,
  validateSettledParticipantEdit,
  validateSplitTotalMatchesTransaction,
} from "./validate";

describe("validateSplitTotalMatchesTransaction (review: split total trusted the browser)", () => {
  test("rejects a balanced ₹200 split posted against a ₹100 transaction", () => {
    // The parts add up, so the balance check alone would pass this.
    expect(
      validateSplitBalances({
        totalPaise: 20000,
        yourSharePaise: 10000,
        participants: [p(10000, "Aryan")],
      }).ok,
    ).toBe(true);
    const r = validateSplitTotalMatchesTransaction({
      totalPaise: 20000,
      transactionAmountPaise: 10000,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("₹200.00");
    expect(r.ok === false && r.message).toContain("₹100.00");
  });

  test("accepts the transaction's own amount", () => {
    expect(
      validateSplitTotalMatchesTransaction({
        totalPaise: 116403,
        transactionAmountPaise: 116403,
      }).ok,
    ).toBe(true);
  });
});

describe("validateParticipantIdsBelongToSplit (review: participant ids not pinned to the split)", () => {
  const existing = new Set(["p-nitin", "p-rishith"]);

  test("rejects an id from some other split instead of treating it as a new row", () => {
    const r = validateParticipantIdsBelongToSplit(
      [p(100, "Nitin", "p-nitin"), p(100, "Bob", "p-from-elsewhere")],
      existing,
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("Bob");
  });

  test("rejects any id when the split doesn't exist yet", () => {
    expect(
      validateParticipantIdsBelongToSplit([p(100, "Nitin", "p-nitin")], new Set())
        .ok,
    ).toBe(false);
  });

  test("accepts rows without an id (new participants) and rows on this split", () => {
    expect(
      validateParticipantIdsBelongToSplit(
        [p(100, "Nitin", "p-nitin"), p(50, "Newcomer")],
        existing,
      ).ok,
    ).toBe(true);
  });
});

describe("validateSettledParticipantEdit (review: settled payments could be reassigned by rename)", () => {
  const aryan = { personName: "Aryan", expectedAmountPaise: 5000 };

  test("refuses to rename a participant who has money settled against them", () => {
    const r = validateSettledParticipantEdit({
      existing: aryan,
      kept: { personName: "Bob", expectedAmountPaise: 5000 },
      settledPaise: 5000,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("rename Aryan to Bob");
  });

  test("treats a case or whitespace change as the same person", () => {
    expect(
      validateSettledParticipantEdit({
        existing: aryan,
        kept: { personName: "  aryan ", expectedAmountPaise: 5000 },
        settledPaise: 5000,
      }).ok,
    ).toBe(true);
  });

  test("renaming is free when nothing has been settled", () => {
    expect(
      validateSettledParticipantEdit({
        existing: aryan,
        kept: { personName: "Bob", expectedAmountPaise: 5000 },
        settledPaise: 0,
      }).ok,
    ).toBe(true);
  });

  test("still refuses removal of a settled participant", () => {
    const r = validateSettledParticipantEdit({
      existing: aryan,
      kept: undefined,
      settledPaise: 100,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("Cannot remove Aryan");
  });

  test("blocks cutting a share below what was settled", () => {
    const r = validateSettledParticipantEdit({
      existing: aryan,
      kept: { personName: "Aryan", expectedAmountPaise: 4000 },
      settledPaise: 5000,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("Cannot reduce Aryan's share");
  });

  test("keeps an existing overpayment editable when the edit doesn't worsen it", () => {
    // Share already below settled (they overpaid). Raising it toward what was
    // received must be allowed — commit 71d8397's rule, preserved here.
    expect(
      validateSettledParticipantEdit({
        existing: { personName: "Rishith", expectedAmountPaise: 121634 },
        kept: { personName: "Rishith", expectedAmountPaise: 121700 },
        settledPaise: 122000,
      }).ok,
    ).toBe(true);
  });
});

describe("cleanAllocations (review: negative allocations were dropped before validation)", () => {
  test("a negative amount fails the request instead of vanishing", () => {
    const r = cleanAllocations([
      { splitParticipantId: "a", amountPaise: 1000 },
      { splitParticipantId: "b", amountPaise: -1000 },
    ]);
    expect(r.ok).toBe(false);
  });

  test("a NaN amount is rejected, not treated as zero", () => {
    expect(
      cleanAllocations([{ splitParticipantId: "a", amountPaise: Number.NaN }])
        .ok,
    ).toBe(false);
  });

  test("zero rows are dropped only after every amount has passed", () => {
    const r = cleanAllocations([
      { splitParticipantId: "a", amountPaise: 0 },
      { splitParticipantId: "b", amountPaise: 250 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.allocations).toEqual([
      { splitParticipantId: "b", amountPaise: 250 },
    ]);
  });
});

describe("validateInflowCapacity (review: ordinary Settle deleted Net Settle's rows)", () => {
  test("only what Net Settle left over can be allocated", () => {
    const r = validateInflowCapacity({
      inflowAmountPaise: 10000,
      reservedByNetSettlePaise: 6000,
      allocationsSumPaise: 5000,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("₹40.00 available");
    expect(r.ok === false && r.message).toContain("Net Settle");
  });

  test("the full credit is available when nothing is reserved", () => {
    expect(
      validateInflowCapacity({
        inflowAmountPaise: 10000,
        reservedByNetSettlePaise: 0,
        allocationsSumPaise: 10000,
      }).ok,
    ).toBe(true);
  });

  test("exactly filling the leftover is allowed", () => {
    expect(
      validateInflowCapacity({
        inflowAmountPaise: 10000,
        reservedByNetSettlePaise: 6000,
        allocationsSumPaise: 4000,
      }).ok,
    ).toBe(true);
  });
});
