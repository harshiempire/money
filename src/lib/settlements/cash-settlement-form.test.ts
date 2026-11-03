import { describe, expect, spyOn, test } from "bun:test";
import { FieldApi, FormApi } from "@tanstack/react-form";
import { callAction } from "@/lib/action/result";
import {
  buildCashSettlementPayload,
  initialCashSettlementFormValues,
  validateCashSettlementForm,
  type CashSettlementFormValues,
} from "./cash-settlement-form";

// Oracle: the old dialog's conversions, initialisers, validation and action
// argument, copied verbatim; hook state is passed in instead.
const paiseToRupeesStr = (p: number) => (p / 100).toFixed(2);
const rupeesToPaise = (r: string) => Math.round(Number.parseFloat(r) * 100);
function legacyInitial(outstandingPaise: number) {
  return { amount: paiseToRupeesStr(outstandingPaise), note: "" };
}
function legacyValid(amount: string) {
  const parsedPaise = rupeesToPaise(amount);
  const isValid = Number.isFinite(parsedPaise) && parsedPaise > 0;
  return isValid;
}
function legacyPayload(splitParticipantId: string, amount: string, note: string) {
  const parsedPaise = rupeesToPaise(amount);
  return {
    splitParticipantId,
    amountPaise: parsedPaise,
    note,
  };
}

describe("cash settlement form parity", () => {
  test("prefills outstanding with two decimals and an empty note", () => {
    for (const amount of [0, 1, 99, 100, 12345, -50]) {
      expect(initialCashSettlementFormValues(amount)).toStrictEqual(legacyInitial(amount));
    }
    expect(initialCashSettlementFormValues(12345)).toStrictEqual({ amount: "123.45", note: "" });
  });

  test("validation and payload match the old rounded-paise logic, including permissive parsing", () => {
    for (const amount of ["", " ", "junk", "NaN", "Infinity", "1e309", "0", "-1", "0.001", "0.005", "0.01", "1.005", "12.345", " 12.34 ", "12cash", "1e2", "999999"]) {
      const values = { amount, note: "  Cash from Alex Example  " };
      expect(validateCashSettlementForm(values) === undefined).toBe(legacyValid(amount));
      expect(buildCashSettlementPayload(values, "participant-1")).toStrictEqual(
        legacyPayload("participant-1", amount, values.note),
      );
    }
  });

  test("notes are sent exactly as typed, including empty and whitespace", () => {
    for (const note of ["", "  ", "  Lunch\n cash  "]) {
      expect(buildCashSettlementPayload({ amount: "0.07", note }, "participant-1")).toStrictEqual({
        splitParticipantId: "participant-1", amountPaise: 7, note,
      });
    }
    // Outstanding is only a separate Save gate; there was never a client cap.
    expect(validateCashSettlementForm({ amount: "999999", note: "" })).toBeUndefined();
  });
});

describe("cash settlement FormApi", () => {
  test("the mounted form blocks an invalid amount and validates edits like the field", async () => {
    let calls = 0;
    const form = new FormApi({
      defaultValues: initialCashSettlementFormValues(0),
      validators: {
        onMount: ({ value }) => validateCashSettlementForm(value),
        onChange: ({ value }) => validateCashSettlementForm(value),
      },
      onSubmit: async () => { calls++; },
    });
    const unmount = form.mount();
    const field = new FieldApi({ form, name: "amount" });
    const unmountField = field.mount();
    try {
      expect(form.state.errors[0]).toBe(true);
      await form.handleSubmit();
      expect(calls).toBe(0);
      field.handleChange("1.23");
      expect(form.state.errors).toEqual([]);
      await form.handleSubmit();
      expect(calls).toBe(1);
      field.handleChange("junk");
      await form.handleSubmit();
      expect(calls).toBe(1);
    } finally {
      unmountField();
      unmount();
    }
  });

  test("three unchanged handleSubmit calls reach onSubmit after an action failure and INTERNAL", async () => {
    let calls = 0;
    const alerts: string[] = [];
    const payloads: ReturnType<typeof buildCashSettlementPayload>[] = [];
    const form = new FormApi({
      defaultValues: { amount: "1.23", note: "  Cash  " } satisfies CashSettlementFormValues,
      validators: {
        onMount: ({ value }) => validateCashSettlementForm(value),
        onChange: ({ value }) => validateCashSettlementForm(value),
      },
      onSubmit: async ({ value }) => {
        calls++;
        const result = await callAction(async () => {
          payloads.push(buildCashSettlementPayload(value, "participant-1"));
          if (calls === 1) return { ok: false, code: "CONFLICT", message: "Amount changed" };
          if (calls === 2) throw new Error("Synthetic network failure");
          return { ok: true, data: undefined };
        });
        if (!result.ok) alerts.push(result.message);
      },
    });
    const unmount = form.mount();
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) {
        await form.handleSubmit();
        expect(form.state.errors).toEqual([]);
      }
      expect(calls).toBe(3);
      expect(payloads).toEqual(Array(3).fill({ splitParticipantId: "participant-1", amountPaise: 123, note: "  Cash  " }));
      expect(alerts).toEqual(["Amount changed", "Something went wrong. Please try again."]);
    } finally {
      log.mockRestore();
      unmount();
    }
  });

  test("the component's isSubmitting guard prevents overlapping submissions", async () => {
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const form = new FormApi({
      defaultValues: initialCashSettlementFormValues(100),
      onSubmit: async () => {
        calls++;
        entered();
        await new Promise<void>((resolve) => { finish = resolve; });
      },
    });
    const unmount = form.mount();
    try {
      const submit = async () => {
        if (form.state.isSubmitting) return;
        await form.handleSubmit();
      };
      const first = submit();
      await started;
      await submit();
      expect(calls).toBe(1);
      finish();
      await first;
    } finally {
      unmount();
    }
  });
});
