import { describe, expect, spyOn, test } from "bun:test";
import { FieldApi, FormApi } from "@tanstack/react-form";
import { callAction } from "@/lib/action/result";
import {
  buildNotePayloads,
  initialNoteFormValues,
  noteSelectionWarning,
  toggleNotePick,
} from "./note-form";

// Oracle: old NoteDialog payloads and conditions copied verbatim, with the
// draft/picked hook state passed in instead of closed over by save().
function legacyPayloads(transactionId: string, draft: string, picked: Set<string>) {
  const save = { transactionId, note: draft };
  let apply = null;
  if (picked.size > 0 && draft.trim().length > 0) {
    apply = {
      transactionIds: [...picked],
      note: draft,
    };
  }
  return { save, apply };
}
function legacyToggle(prev: Set<string>, id: string) {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

describe("note form parity", () => {
  test("initial values and reopen use the current note with no checked rows", () => {
    for (const note of [null, "", "  ", "  Example note\n  "]) {
      expect(initialNoteFormValues(note)).toStrictEqual({ draft: note ?? "", picked: new Set() });
    }
    const first = initialNoteFormValues(null);
    first.picked.add("txn-2");
    expect(initialNoteFormValues(null).picked.size).toBe(0);
  });

  test("payloads preserve raw text, selection order and the blank-note bulk skip", () => {
    for (const draft of ["", "  \n ", " Lunch ", "0", "Sample\nnote"]) {
      for (const picked of [new Set<string>(), new Set(["txn-3", "txn-2"])]) {
        const values = { draft, picked };
        expect(buildNotePayloads(values, "txn-1")).toStrictEqual(legacyPayloads("txn-1", draft, picked));
        expect(noteSelectionWarning(values)).toBe(
          picked.size > 0 && draft.trim().length === 0
            ? "Type the note text above first — checked rows are ignored when the field is empty."
            : undefined,
        );
      }
    }
  });

  test("toggle preserves insertion order and does not mutate the previous selection", () => {
    let picked = new Set<string>();
    for (const id of ["txn-3", "txn-2", "txn-3", "txn-3"]) {
      const before = [...picked];
      const next = toggleNotePick(picked, id);
      expect(next).toStrictEqual(legacyToggle(picked, id));
      expect([...picked]).toEqual(before);
      picked = next;
    }
    expect([...picked]).toEqual(["txn-2", "txn-3"]);
  });
});

describe("note FormApi", () => {
  test("field edits, Set selections, copy, All/None and reopen retain the old values", () => {
    const defaultValues = initialNoteFormValues("Original");
    const form = new FormApi({ defaultValues });
    const unmount = form.mount();
    const field = new FieldApi({ form, name: "draft" });
    const unmountField = field.mount();
    try {
      field.handleChange("Edited");
      form.setFieldValue("picked", (prev) => toggleNotePick(prev, "txn-2"));
      expect(form.state.values).toStrictEqual({ draft: "Edited", picked: new Set(["txn-2"]) });
      form.setFieldValue("picked", new Set(["txn-3", "txn-2"]));
      form.setFieldValue("draft", "Copied note");
      expect(buildNotePayloads(form.state.values, "txn-1").apply).toStrictEqual({ transactionIds: ["txn-3", "txn-2"], note: "Copied note" });
      form.setFieldValue("picked", new Set());
      expect(form.state.values.picked.size).toBe(0);
      form.reset(initialNoteFormValues("Updated prop"), { keepDefaultValues: true });
      // useForm updates its options after every render with the defaults
      // captured at mount. Reopening must keep the latest note prop anyway.
      form.update({ defaultValues });
      expect(form.state.values).toStrictEqual({ draft: "Updated prop", picked: new Set() });
    } finally {
      unmountField();
      unmount();
    }
  });

  test("three unchanged submits reach onSubmit after single-save and partial bulk failures", async () => {
    let calls = 0;
    const saved: unknown[] = [];
    const applied: unknown[] = [];
    const errors: string[] = [];
    const feedback: string[] = [];
    const form = new FormApi({
      defaultValues: { draft: "  Lunch  ", picked: new Set(["txn-3", "txn-2"]) },
      onSubmit: async ({ value }) => {
        calls++;
        const payloads = buildNotePayloads(value, "txn-1");
        const result = await callAction(async () => {
          saved.push(payloads.save);
          return calls === 1
            ? { ok: false, code: "CONFLICT", message: "Note changed" }
            : { ok: true, data: undefined };
        });
        if (!result.ok) { errors.push(result.message); return; }
        if (payloads.apply) {
          const result = await callAction(async () => {
            applied.push(payloads.apply);
            return calls === 2
              ? { ok: false, code: "UNAVAILABLE", message: "Try later" }
              : { ok: true, data: { updated: 2 } };
          });
          if (!result.ok) { errors.push(`Saved here, but not on the other rows: ${result.message}`); return; }
          const r = result.data;
          feedback.push(`Saved here and on ${r.updated} other row${r.updated === 1 ? "" : "s"}`);
        }
      },
    });
    const unmount = form.mount();
    try {
      for (let i = 0; i < 3; i++) {
        await form.handleSubmit();
        expect(form.state.errors).toEqual([]);
      }
      expect(calls).toBe(3);
      expect(saved).toEqual(Array(3).fill({ transactionId: "txn-1", note: "  Lunch  " }));
      expect(applied).toEqual(Array(2).fill({ transactionIds: ["txn-3", "txn-2"], note: "  Lunch  " }));
      expect(errors).toEqual(["Note changed", "Saved here, but not on the other rows: Try later"]);
      expect(feedback).toEqual(["Saved here and on 2 other rows"]);
    } finally {
      unmount();
    }
  });

  test("a blank draft with checked rows is advisory and still submits three times", async () => {
    let calls = 0;
    const form = new FormApi({
      defaultValues: { draft: " \n ", picked: new Set(["txn-2"]) },
      onSubmit: async ({ value }) => {
        calls++;
        expect(noteSelectionWarning(value)).toBeDefined();
        expect(buildNotePayloads(value, "txn-1")).toStrictEqual({ save: { transactionId: "txn-1", note: " \n " }, apply: null });
      },
    });
    const unmount = form.mount();
    try {
      await form.handleSubmit();
      await form.handleSubmit();
      await form.handleSubmit();
      expect(calls).toBe(3);
    } finally {
      unmount();
    }
  });

  test("INTERNAL fallback remains retryable without clearing form errors", async () => {
    let calls = 0;
    const errors: string[] = [];
    const form = new FormApi({
      defaultValues: initialNoteFormValues("Example"),
      onSubmit: async () => {
        calls++;
        const result = await callAction(async () => { throw new Error("Synthetic network failure"); });
        if (!result.ok) errors.push(result.message);
      },
    });
    const unmount = form.mount();
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await form.handleSubmit();
      await form.handleSubmit();
      await form.handleSubmit();
      expect(calls).toBe(3);
      expect(errors).toEqual(Array(3).fill("Something went wrong. Please try again."));
    } finally {
      log.mockRestore();
      unmount();
    }
  });
});
