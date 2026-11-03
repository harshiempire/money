// Plain form values and payloads; no React, Effect or server dependencies.
export interface NoteFormValues {
  draft: string;
  picked: Set<string>;
}

export function initialNoteFormValues(note: string | null): NoteFormValues {
  return { draft: note ?? "", picked: new Set<string>() };
}

export function toggleNotePick(picked: Set<string>, id: string): Set<string> {
  const next = new Set(picked);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** This is advisory: a blank note still saves here, ignoring checked rows. */
export function noteSelectionWarning(values: NoteFormValues): string | undefined {
  return values.picked.size > 0 && values.draft.trim().length === 0
    ? "Type the note text above first — checked rows are ignored when the field is empty."
    : undefined;
}

export function buildNotePayloads(values: NoteFormValues, transactionId: string) {
  return {
    save: { transactionId, note: values.draft },
    apply:
      values.picked.size > 0 && values.draft.trim().length > 0
        ? { transactionIds: [...values.picked], note: values.draft }
        : null,
  };
}
