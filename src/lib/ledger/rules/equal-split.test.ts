import { describe, expect, test } from "bun:test";
import { equalShares } from "./equal-split";
import { splitAmounts } from "@/lib/mcp/write-rules";
import { autoSuggestYourShare, equalSplitValues, paiseToRupeesStr, rupeesToPaise, type SplitFormValues } from "@/lib/splits/split-form";

const form = (people: number): SplitFormValues => ({
  yourShare: "",
  note: "",
  participants: Array.from({ length: people }, (_, i) => ({ personName: `Person ${i}`, expectedRupees: "" })),
});

describe("equalShares", () => {
  test("₹760 half each", () => {
    expect(equalShares(76000, 1)).toEqual({ yours: 38000, each: 38000 });
  });
  test("the odd paisa goes to you", () => {
    expect(equalShares(10001, 1)).toEqual({ yours: 5001, each: 5000 });
    expect(equalShares(10000, 2)).toEqual({ yours: 3334, each: 3333 });
  });
  test("a bill smaller than the group leaves it all with you", () => {
    expect(equalShares(2, 4)).toEqual({ yours: 2, each: 0 });
  });
});

describe("every door divides the same way", () => {
  const totals = [1, 2, 99, 100, 101, 10000, 10001, 33334, 76000, 100000, 123457, 9999999];
  for (const people of [1, 2, 3, 4, 6, 7, 12]) {
    test(`${people} other people`, () => {
      for (const total of totals) {
        const { yours, each } = equalShares(total, people);
        expect(yours + each * people).toBe(total);

        const agent = splitAmounts(total, Array.from({ length: people }, () => undefined), undefined, true);
        expect(agent).toEqual({ yours, participants: Array.from({ length: people }, () => each) });

        const rupees = paiseToRupeesStr(total);
        const dialog = equalSplitValues(form(people), rupees)!;
        expect(rupeesToPaise(dialog.yourShare)).toBe(yours);
        expect(dialog.participants.map((row) => rupeesToPaise(row.expectedRupees))).toEqual(Array.from({ length: people }, () => each));

        expect(autoSuggestYourShare(form(people), rupees, false)).toBe(dialog.yourShare);
      }
    });
  }
});
