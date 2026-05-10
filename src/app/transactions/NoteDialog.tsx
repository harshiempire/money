"use client";

import { useRef, useState, useTransition } from "react";
import { applyNoteToCounterparty, setTransactionNote } from "./actions";

export function NoteButton({
  transactionId,
  note,
  hasCounterparty,
}: {
  transactionId: string;
  note: string | null;
  hasCounterparty: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(note ?? "");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const open = () => {
    setDraft(note ?? "");
    setFeedback(null);
    dialogRef.current?.showModal();
  };
  const close = () => dialogRef.current?.close();

  const save = () => {
    startTransition(async () => {
      await setTransactionNote({ transactionId, note: draft });
      close();
    });
  };

  const saveAndApply = () => {
    startTransition(async () => {
      await setTransactionNote({ transactionId, note: draft });
      const r = await applyNoteToCounterparty({ transactionId });
      // Stay open briefly to show the count, then close.
      setFeedback(
        r.updated === 0
          ? "Saved (no other unset rows from this counterparty)"
          : `Saved and applied to ${r.updated} other row${r.updated === 1 ? "" : "s"}`,
      );
      setTimeout(() => {
        close();
        setFeedback(null);
      }, 900);
    });
  };

  const hasNote = (note ?? "").trim().length > 0;

  return (
    <>
      <button
        type="button"
        onClick={open}
        title={hasNote ? note ?? "" : "Add a note"}
        className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
          hasNote
            ? "border-amber-400 text-amber-700 dark:border-amber-700 dark:text-amber-300"
            : "border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
        }`}
      >
        {hasNote ? "Note ✎" : "Note…"}
      </button>
      <dialog
        ref={dialogRef}
        className="rounded-lg p-0 backdrop:bg-black/40 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <div className="w-[28rem] max-w-[90vw] p-5">
          <header className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Note</h2>
            <button
              type="button"
              onClick={close}
              className="text-sm text-neutral-500 hover:underline"
            >
              Close
            </button>
          </header>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            placeholder="e.g. iCloud 200GB renewal"
            className="w-full rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          />
          {feedback && (
            <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
              {feedback}
            </p>
          )}
          <footer className="mt-4 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={close}
              disabled={pending}
              className="rounded px-3 py-1.5 text-sm text-neutral-600 disabled:opacity-50 dark:text-neutral-400"
            >
              Cancel
            </button>
            <div className="flex items-center gap-2">
              {hasCounterparty && draft.trim().length > 0 && (
                <button
                  type="button"
                  onClick={saveAndApply}
                  disabled={pending}
                  title="Save and copy this note to every other row from the same counterparty that has no note yet"
                  className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300"
                >
                  {pending ? "Working…" : "Save & apply to all"}
                </button>
              )}
              <button
                type="button"
                onClick={save}
                disabled={pending}
                className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
              >
                {pending ? "Saving…" : "Save"}
              </button>
            </div>
          </footer>
        </div>
      </dialog>
    </>
  );
}
