import { expect, test } from "bun:test";
import { modelAmount, modelDate, modelSafePayee, modelSafeText, userChosenDisplayName } from "./model-view";

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

test("handle-shaped payees fall through display name, purpose and bank label", () => {
  for (const handle of ["paytm.s2wy2f", "rohanrao.b-", "q123456", "ravi_k", "ravi-", "ravi1"]) {
    expect(modelSafePayee({ counterpartyDisplayName: handle, parsedPurpose: "Swiggy", label: "Payee" })).toBe("Swiggy");
    expect(modelSafePayee({ counterpartyDisplayName: handle, parsedPurpose: handle, label: "Petrol" })).toBe("Petrol");
    expect(modelSafePayee({ counterpartyDisplayName: handle, parsedPurpose: handle, label: handle })).toBe("Payee");
  }
});

test("only a renamed UPI counterparty supplies a display name to the model", () => {
  expect(userChosenDisplayName({ kind: "upi_handle", key: "ravi", displayName: " Ra Vi\t" })).toBeNull();
  expect(userChosenDisplayName({ kind: "upi_handle", key: " Ravi.K @bank ", displayName: "ravi.k@BANK" })).toBeNull();
  expect(userChosenDisplayName({ kind: "upi_handle", key: "ravi.k@bank", displayName: "Ravi Kumar" })).toBe("Ravi Kumar");
  expect(userChosenDisplayName({ kind: "name", key: "Swiggy", displayName: "Swiggy" })).toBe("Swiggy");
  expect(userChosenDisplayName({ kind: null, key: null, displayName: null })).toBeNull();
});

test("normal payee names remain usable and handle-shaped notes are unchanged", () => {
  for (const name of ["Swiggy", "Padmavathi Tiffins", "ACME PAYROLL", "groceries", "lunch", "Petrol"]) {
    expect(modelSafePayee({ counterpartyDisplayName: name, parsedPurpose: null, label: "Payee" })).toBe(name);
    expect(modelSafePayee({ counterpartyDisplayName: null, parsedPurpose: name, label: "Payee" })).toBe(name);
  }
  expect(modelSafeText("ravi_k")).toBe("ravi_k");
});
