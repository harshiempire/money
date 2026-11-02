import { expect, test } from "bun:test";
import { modelAmount, modelDate, modelSafePayee } from "./model-view";

test("modelSafePayee never leaks handles with phone or account numbers", () => {
  expect(modelSafePayee({ counterpartyDisplayName: "Nitin K", parsedPurpose: null, label: "nitin.k@okaxis" })).toBe("Nitin K");
  expect(modelSafePayee({ counterpartyDisplayName: null, parsedPurpose: "Swiggy", label: "swiggy.stores@axb" })).toBe("Swiggy");
  expect(modelSafePayee({ counterpartyDisplayName: null, parsedPurpose: null, label: "paytmqr1k9x@paytm" })).toBe("Payee");
  expect(modelSafePayee({ counterpartyDisplayName: null, parsedPurpose: "V", label: "8125246237@ybl" })).toBe("Payee");
  expect(modelSafePayee({ counterpartyDisplayName: "9949872008", parsedPurpose: null, label: "9949872008@" })).toBe("Payee");
  expect(modelSafePayee({ counterpartyDisplayName: null, parsedPurpose: null, label: "GR0WW INVEST TECH PVT LTD" })).toBe(
    "GR0WW INVEST TECH PVT LTD",
  );
});

test("model formats", () => {
  expect(modelDate("2026-08-14")).toBe("14 Aug 2026");
  expect(modelAmount(112000)).toBe("₹1,120.00");
  expect(modelAmount(76050)).toBe("₹760.50");
});
