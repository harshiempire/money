import { describe, expect, test } from "bun:test";
import {
  autoSuggestYourShare,
  buildCreateSplitPayload,
  computeSplitBalance,
  equalSplitValues,
  initialSplitFormValues,
  newParticipantRow,
  paiseToRupeesStr,
  rupeesToPaise,
  splitBalanceError,
  splitFormSignature,
  validateSplitForm,
  type SplitFormExisting,
  type SplitFormParticipant,
  type SplitFormValues,
} from "./split-form";

// ---------------------------------------------------------------------------
// Oracle: the pre-TanStack SplitDialog logic, copied verbatim (state passed in
// instead of read from useState). The new module must agree with it exactly.
// ---------------------------------------------------------------------------
const legacyRupeesToPaise = (r: string) => Math.round(Number.parseFloat(r) * 100);

function legacySubmitPayload(
  transactionId: string,
  total: string,
  yourShare: string,
  note: string,
  participants: SplitFormParticipant[],
) {
  const cleaned = participants
    .filter((p) => p.personName.trim() && p.expectedRupees.trim())
    .map((p) => ({
      id: p.id,
      personName: p.personName.trim(),
      expectedAmountPaise: legacyRupeesToPaise(p.expectedRupees),
    }));
  const totalPaise = legacyRupeesToPaise(total);
  let yourSharePaise = legacyRupeesToPaise(yourShare);
  if (!Number.isFinite(yourSharePaise)) {
    const participantsSum = cleaned.reduce((s, p) => s + p.expectedAmountPaise, 0);
    yourSharePaise = Number.isFinite(totalPaise)
      ? Math.max(0, totalPaise - participantsSum)
      : 0;
  }
  return {
    transactionId,
    totalPaise: Number.isFinite(totalPaise) ? totalPaise : 0,
    yourSharePaise,
    note: note.trim() || null,
    participants: cleaned,
  };
}

function legacyBalance(total: string, yourShare: string, participants: SplitFormParticipant[]) {
  const totalPaiseLive = legacyRupeesToPaise(total);
  const totalValid = Number.isFinite(totalPaiseLive);
  const yourSharePaiseLive = yourShare.trim() === "" ? null : legacyRupeesToPaise(yourShare);
  const participantsSumLive = participants
    .filter((p) => p.personName.trim() && p.expectedRupees.trim())
    .reduce((s, p) => {
      const v = legacyRupeesToPaise(p.expectedRupees);
      return s + (Number.isFinite(v) ? v : 0);
    }, 0);
  const effectiveYourSharePaise =
    yourSharePaiseLive != null && Number.isFinite(yourSharePaiseLive)
      ? yourSharePaiseLive
      : totalValid
        ? Math.max(0, totalPaiseLive - participantsSumLive)
        : 0;
  const residualPaise = totalValid
    ? totalPaiseLive - (effectiveYourSharePaise + participantsSumLive)
    : 0;
  return {
    totalPaiseLive,
    totalValid,
    effectiveYourSharePaise,
    participantsSumLive,
    residualPaise,
    isBalanced: totalValid && residualPaise === 0,
  };
}

const values = (
  yourShare: string,
  participants: SplitFormParticipant[],
  note = "",
): SplitFormValues => ({ yourShare, note, participants });

const row = (personName: string, expectedRupees: string, id?: string): SplitFormParticipant =>
  id === undefined ? { personName, expectedRupees } : { id, personName, expectedRupees };

describe("paise conversions", () => {
  test("paise render as two-decimal rupees", () => {
    expect(paiseToRupeesStr(0)).toBe("0.00");
    expect(paiseToRupeesStr(5)).toBe("0.05");
    expect(paiseToRupeesStr(123456)).toBe("1234.56");
  });

  test("rupee strings round to whole paise; blank and junk are NaN", () => {
    expect(rupeesToPaise("12")).toBe(1200);
    expect(rupeesToPaise("12.5")).toBe(1250);
    expect(rupeesToPaise("0.07")).toBe(7);
    expect(rupeesToPaise("1.005")).toBe(legacyRupeesToPaise("1.005"));
    expect(rupeesToPaise("")).toBeNaN();
    expect(rupeesToPaise("abc")).toBeNaN();
  });
});

describe("initialSplitFormValues", () => {
  test("a new split starts with a blank share, blank note and one empty row", () => {
    expect(initialSplitFormValues(null)).toStrictEqual({
      yourShare: "",
      note: "",
      participants: [{ personName: "", expectedRupees: "" }],
    });
  });

  test("editing prefills from the existing split and keeps participant ids", () => {
    expect(
      initialSplitFormValues({
        yourSharePaise: 33334,
        note: "Team lunch",
        participants: [
          { id: "part-1", personName: "Alex Example", expectedAmountPaise: 33333 },
          { id: "part-2", personName: "Sam Sample", expectedAmountPaise: 33333 },
        ],
      }),
    ).toStrictEqual({
      yourShare: "333.34",
      note: "Team lunch",
      participants: [
        { id: "part-1", personName: "Alex Example", expectedRupees: "333.33" },
        { id: "part-2", personName: "Sam Sample", expectedRupees: "333.33" },
      ],
    });
  });

  test("a null note becomes blank; no participants falls back to one empty row", () => {
    expect(
      initialSplitFormValues({ yourSharePaise: 1000, note: null, participants: [] }),
    ).toStrictEqual({
      yourShare: "10.00",
      note: "",
      participants: [{ personName: "", expectedRupees: "" }],
    });
  });

  test("the add-participant row has no id", () => {
    expect(newParticipantRow()).toStrictEqual({ personName: "", expectedRupees: "" });
  });
});

describe("splitFormSignature", () => {
  const existing: SplitFormExisting = {
    yourSharePaise: 4000,
    note: "Team lunch",
    participants: [
      {
        id: "part-1",
        personName: "Alex Example",
        expectedAmountPaise: 6000,
        settledAmountPaise: 1000,
      },
    ],
  };

  test("identical splits have equal signatures regardless of object identity or property order", () => {
    expect(splitFormSignature(existing)).toBe(
      splitFormSignature({
        participants: existing.participants.map((p) => ({
          settledAmountPaise: p.settledAmountPaise,
          expectedAmountPaise: p.expectedAmountPaise,
          personName: p.personName,
          id: p.id,
        })),
        note: existing.note,
        yourSharePaise: existing.yourSharePaise,
      }),
    );
    expect(splitFormSignature(null)).toBe(splitFormSignature(null));
  });

  test.each([
    ["share", { ...existing, yourSharePaise: 4001 }],
    ["note", { ...existing, note: "Dinner" }],
    ["null note", { ...existing, note: null }],
    ["id", { ...existing, participants: [{ ...existing.participants[0], id: "part-2" }] }],
    ["name", { ...existing, participants: [{ ...existing.participants[0], personName: "Sam Sample" }] }],
    ["amount", { ...existing, participants: [{ ...existing.participants[0], expectedAmountPaise: 6001 }] }],
    ["settled amount", { ...existing, participants: [{ ...existing.participants[0], settledAmountPaise: 1001 }] }],
    ["removed participant", { ...existing, participants: [] }],
  ])("changes when the saved %s changes", (_, changed) => {
    expect(splitFormSignature(changed)).not.toBe(splitFormSignature(existing));
  });

  test("null and a saved split have different signatures", () => {
    expect(splitFormSignature(null)).not.toBe(splitFormSignature(existing));
  });
});

describe("autoSuggestYourShare", () => {
  test("new split, blank share: your part of an equal split, with leftover paise", () => {
    expect(autoSuggestYourShare(values("", [row("Alex", ""), row("", "")]), "100.00", false)).toBe(
      "50.00",
    );
    expect(
      autoSuggestYourShare(values("", [row("Alex", ""), row("Sam", "")]), "100.00", false),
    ).toBe("33.34");
  });

  test("an unreadable total suggests nothing", () => {
    expect(autoSuggestYourShare(values("", [row("Alex", "")]), "abc", false)).toBeNull();
  });

  test("does nothing for an existing split, a typed share, or nobody named", () => {
    expect(autoSuggestYourShare(values("", [row("Alex", "")]), "100.00", true)).toBeNull();
    expect(autoSuggestYourShare(values("20", [row("Alex", "")]), "100.00", false)).toBeNull();
    expect(autoSuggestYourShare(values("", [row("", ""), row("", "")]), "100.00", false)).toBeNull();
    expect(autoSuggestYourShare(values("", [row("Alex", "")]), "", false)).toBeNull();
  });

  test("an untrimmed whitespace name counts, as before", () => {
    expect(autoSuggestYourShare(values("", [row(" ", "")]), "100.00", false)).toBe("50.00");
  });
});

describe("equalSplitValues", () => {
  test("₹1000 three ways: remainder paise go to your share", () => {
    expect(
      equalSplitValues(values("", [row("Alex", ""), row("Sam", "", "part-2")]), "1000.00"),
    ).toStrictEqual({
      yourShare: "333.34",
      participants: [
        { id: undefined, personName: "Alex", expectedRupees: "333.33" },
        { id: "part-2", personName: "Sam", expectedRupees: "333.33" },
      ],
    });
  });

  test("an even split has no remainder", () => {
    expect(equalSplitValues(values("", [row("Alex", "5")]), "100.00")).toStrictEqual({
      yourShare: "50.00",
      participants: [{ id: undefined, personName: "Alex", expectedRupees: "50.00" }],
    });
  });

  test("unnamed and whitespace-only rows are dropped", () => {
    const next = equalSplitValues(
      values("", [row("", "10"), row("Alex", ""), row("   ", "4"), row("Sam", "")]),
      "0.10",
    );
    expect(next).toStrictEqual({
      yourShare: "0.04",
      participants: [
        { id: undefined, personName: "Alex", expectedRupees: "0.03" },
        { id: undefined, personName: "Sam", expectedRupees: "0.03" },
      ],
    });
  });

  test("the parts always sum back to the total", () => {
    for (const totalPaise of [1, 2, 99, 100, 101, 99999, 100000, 123457]) {
      for (let people = 1; people <= 7; people++) {
        const participants = Array.from({ length: people }, (_, i) => row(`P${i}`, ""));
        const next = equalSplitValues(values("", participants), paiseToRupeesStr(totalPaise));
        expect(next).not.toBeNull();
        const sum =
          rupeesToPaise(next!.yourShare) +
          next!.participants.reduce((s, p) => s + rupeesToPaise(p.expectedRupees), 0);
        expect(sum).toBe(totalPaise);
      }
    }
  });

  test("nobody named means no change", () => {
    expect(equalSplitValues(values("", [row("", "")]), "100.00")).toBeNull();
    expect(equalSplitValues(values("", []), "100.00")).toBeNull();
  });
});

describe("balance and validation message", () => {
  test("blank share auto-computes as total − participants and balances", () => {
    const b = computeSplitBalance(values("", [row("Alex", "30")]), "100.00");
    expect(b).toStrictEqual({
      totalPaise: 10000,
      totalValid: true,
      effectiveYourSharePaise: 7000,
      participantsSumPaise: 3000,
      residualPaise: 0,
      isBalanced: true,
    });
    expect(splitBalanceError(b)).toBeUndefined();
  });

  test("short of the total: 'unaccounted'", () => {
    expect(validateSplitForm(values("60", [row("Alex", "39")]), "100.00")).toBe(
      "unaccounted ₹1.00",
    );
  });

  test("past the total: 'over by'", () => {
    expect(validateSplitForm(values("60", [row("Alex", "45")]), "100.00")).toBe("over by ₹5.00");
  });

  test("participants alone past the total: blank share clamps to 0, so 'over by'", () => {
    expect(validateSplitForm(values("", [row("Alex", "150")]), "100.00")).toBe("over by ₹50.00");
  });

  test("an unreadable total reports 'unaccounted ₹0.00'", () => {
    expect(validateSplitForm(values("", [row("Alex", "10")]), "")).toBe("unaccounted ₹0.00");
  });

  test("rows without a name or an amount do not count; junk amounts count as 0", () => {
    const b = computeSplitBalance(
      values("50", [row("Alex", "50"), row("", "20"), row("Sam", ""), row("Jo", "abc")]),
      "100.00",
    );
    expect(b.participantsSumPaise).toBe(5000);
    expect(b.isBalanced).toBe(true);
  });

  test("a junk share falls back to the auto value", () => {
    const b = computeSplitBalance(values("abc", [row("Alex", "25")]), "100.00");
    expect(b.effectiveYourSharePaise).toBe(7500);
    expect(b.isBalanced).toBe(true);
  });
});

// Cases shared by the payload and balance parity checks.
const CASES: Array<{ total: string; yourShare: string; note: string; participants: SplitFormParticipant[] }> = [
  { total: "100.00", yourShare: "", note: "", participants: [row("", "")] },
  { total: "100.00", yourShare: "", note: "  ", participants: [row(" Alex ", "30")] },
  { total: "100.00", yourShare: "70", note: " Dinner ", participants: [row("Alex", "30", "part-1")] },
  { total: "1000.00", yourShare: "333.34", note: "", participants: [row("Alex", "333.33"), row("Sam", "333.33", "part-2")] },
  { total: "100.00", yourShare: "", note: "", participants: [row("", "20"), row("Alex", "30"), row("Sam", ""), row("Jo", "50")] },
  { total: "100.00", yourShare: "abc", note: "", participants: [row("Alex", "25")] },
  { total: "100.00", yourShare: "100", note: "", participants: [row("Alex", "abc")] },
  { total: "100.00", yourShare: "", note: "", participants: [row("Alex", "abc")] },
  { total: "100.00", yourShare: "-5", note: "", participants: [row("Alex", "105")] },
  { total: "100.00", yourShare: "", note: "", participants: [row("Alex", "150")] },
  { total: "0.10", yourShare: "0.04", note: "", participants: [row("Alex", "0.03"), row("Sam", "0.03")] },
  { total: "", yourShare: "", note: "x", participants: [row("Alex", "10")] },
  { total: "12.34", yourShare: "1.005", note: "", participants: [row("Alex", "11.335")] },
  { total: "100.00", yourShare: "", note: "", participants: [] },
];

describe("buildCreateSplitPayload", () => {
  test("matches what the previous dialog sent, field for field", () => {
    for (const c of CASES) {
      const input = buildCreateSplitPayload(values(c.yourShare, c.participants, c.note), {
        transactionId: "txn-1",
        totalRupees: c.total,
      });
      expect(input).toStrictEqual(
        legacySubmitPayload("txn-1", c.total, c.yourShare, c.note, c.participants),
      );
    }
  });

  test("an edit sends kept ids back; new rows carry an undefined id", () => {
    const input = buildCreateSplitPayload(
      values("40", [row(" Alex ", "30", "part-1"), row("Sam", "30")], " Lunch "),
      { transactionId: "txn-9", totalRupees: "100.00" },
    );
    expect(input).toStrictEqual({
      transactionId: "txn-9",
      totalPaise: 10000,
      yourSharePaise: 4000,
      note: "Lunch",
      participants: [
        { id: "part-1", personName: "Alex", expectedAmountPaise: 3000 },
        { id: undefined, personName: "Sam", expectedAmountPaise: 3000 },
      ],
    });
  });

  test("blank share means 'I paid the rest'; blank note is null", () => {
    const input = buildCreateSplitPayload(values("", [row("Alex", "30")]), {
      transactionId: "txn-1",
      totalRupees: "100.00",
    });
    expect(input.yourSharePaise).toBe(7000);
    expect(input.note).toBeNull();
  });
});

describe("computeSplitBalance parity", () => {
  test("agrees with the previous dialog's live check", () => {
    for (const c of CASES) {
      const b = computeSplitBalance(values(c.yourShare, c.participants), c.total);
      const legacy = legacyBalance(c.total, c.yourShare, c.participants);
      expect(b).toStrictEqual({
        totalPaise: legacy.totalPaiseLive,
        totalValid: legacy.totalValid,
        effectiveYourSharePaise: legacy.effectiveYourSharePaise,
        participantsSumPaise: legacy.participantsSumLive,
        residualPaise: legacy.residualPaise,
        isBalanced: legacy.isBalanced,
      });
    }
  });
});
