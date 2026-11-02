import { expect, test } from "bun:test";
import { pickNetEventLeg, type NetEventLeg } from "./legs";
import { pickParticipantInput } from "@/lib/splits/types";

test("nested action inputs drop undeclared fields and omit undefined optionals", () => {
  expect(pickParticipantInput({
    personName: "Asha", expectedAmountPaise: 100, id: undefined, isTransfer: true,
  } as Parameters<typeof pickParticipantInput>[0])).toEqual({ personName: "Asha", expectedAmountPaise: 100 });
  expect(pickNetEventLeg({
    kind: "receivable", method: "bank", amountPaise: 100, splitParticipantId: "share",
    isTransfer: true, newPayable: { description: "injected" },
  } as NetEventLeg)).toEqual({ kind: "receivable", method: "bank", amountPaise: 100, splitParticipantId: "share" });
  expect(pickNetEventLeg({
    kind: "payable", method: "offset", amountPaise: 100, isTransfer: true,
    newPayable: {
      personName: "Asha", incurredDate: "2026-10-01", amountPaise: 100,
      description: "Dinner", categoryId: undefined, note: null, sourceInflowTransactionId: "injected",
    },
  } as NetEventLeg)).toEqual({
    kind: "payable", method: "offset", amountPaise: 100,
    newPayable: { personName: "Asha", incurredDate: "2026-10-01", amountPaise: 100, description: "Dinner", note: null },
  });
});

test("payable picker preserves both declared alternatives so the core refuses malformed input", () => {
  const malformed = {
    kind: "payable", method: "offset", amountPaise: 100, owedExpenseId: "owed",
    newPayable: { personName: "Asha", incurredDate: "2026-10-01", amountPaise: 100, description: "Dinner" },
  } as unknown as NetEventLeg;
  expect(pickNetEventLeg(malformed)).toEqual(malformed);
});
