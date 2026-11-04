"use client";

import { useRef, useState, useTransition } from "react";
import { useForm, useSelector } from "@tanstack/react-form";
import {
  applyNoteToTransactions,
  getNoteCandidates,
  setTransactionNote,
} from "./actions";
import { callAction, unwrap } from "@/lib/action/result";
import { useQuery } from "@tanstack/react-query";
import { moneyKeys } from "@/lib/query/keys";
import { useInvalidateMoneyReads, useMoneyQueryUser } from "@/lib/query/use-money-query";
import { formatDate, formatPaiseSigned } from "@/lib/format";
import {
  buildNotePayloads,
  initialNoteFormValues,
  noteSelectionWarning,
  toggleNotePick,
} from "@/lib/notes/note-form";

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
  const [defaultValues] = useState(() => initialNoteFormValues(note));
  const [isOpen, setIsOpen] = useState(false);
  const userId = useMoneyQueryUser();
  const invalidateReads = useInvalidateMoneyReads();
  const query = useQuery({
    queryKey: moneyKeys.candidate(userId, transactionId),
    queryFn: async () => unwrap(await callAction(() => getNoteCandidates({ transactionId }))),
    enabled: isOpen && hasCounterparty && !!userId,
  });
  const candidates = query.isError ? null : query.data ?? null;
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const open = () => {
    form.reset(initialNoteFormValues(note), { keepDefaultValues: true });
    setFeedback(null);
    setError(null);
    setIsOpen(true);
    dialogRef.current?.showModal();
  };
  const close = () => dialogRef.current?.close();

  const togglePick = (id: string) => {
    form.setFieldValue("picked", (prev) => toggleNotePick(prev, id));
  };

  const form = useForm({
    defaultValues,
    // Blank notes are allowed. The checked-row warning must not block Save.
    onSubmit: async ({ value }) => {
      const payloads = buildNotePayloads(value, transactionId);
      const saved = await callAction(() =>
        setTransactionNote(payloads.save),
      );
      if (!saved.ok) {
        setError(saved.message);
        return;
      }
      invalidateReads();
      if (payloads.apply) {
        const input = payloads.apply;
        const applied = await callAction(() =>
          applyNoteToTransactions(input),
        );
        if (!applied.ok) {
          setError(`Saved here, but not on the other rows: ${applied.message}`);
          return;
        }
        invalidateReads();
        const r = applied.data;
        setFeedback(
          `Saved here and on ${r.updated} other row${r.updated === 1 ? "" : "s"}`,
        );
        setTimeout(() => {
          close();
          setFeedback(null);
        }, 700);
      } else {
        close();
      }
    },
  });
  const values = useSelector(form.store, (s) => s.values);
  const { draft, picked } = values;
  const selectionWarning = noteSelectionWarning(values);

  const save = () => {
    if (pending || form.state.isSubmitting) return;
    setError(null);
    startTransition(async () => {
      await form.handleSubmit();
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
        onClose={() => setIsOpen(false)}
        className="rounded-lg p-0 backdrop:bg-black/40 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <div className="w-[36rem] max-w-[90vw] p-5">
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
          <form.Field name="draft">
            {(field) => (
              <textarea
                autoFocus
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                rows={3}
                placeholder="e.g. F1 TV subscription"
                className="w-full rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
              />
            )}
          </form.Field>

          {hasCounterparty && (
            <div className="mt-4">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase text-neutral-500">
                  Also apply this note to:
                </span>
                {candidates && candidates.length > 0 && (
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-neutral-500">
                    <button
                      type="button"
                      onClick={() =>
                        form.setFieldValue("picked", new Set(candidates.map((c) => c.id)))
                      }
                      className="underline-offset-4 hover:underline"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => form.setFieldValue("picked", new Set())}
                      className="underline-offset-4 hover:underline"
                    >
                      None
                    </button>
                  </div>
                )}
              </div>

              <div className="mt-2 max-h-64 overflow-y-auto rounded border border-neutral-200 dark:border-neutral-800">
                {candidates === null ? (
                  <p className="p-3 text-xs text-neutral-500">Loading…</p>
                ) : candidates.length === 0 ? (
                  <p className="p-3 text-xs text-neutral-500">
                    No other transactions from this counterparty.
                  </p>
                ) : (
                  <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
                    {candidates.map((c) => (
                      <li
                        key={c.id}
                        className="hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
                      >
                        <label className="flex cursor-pointer items-center gap-2 p-2">
                          <input
                            type="checkbox"
                            checked={picked.has(c.id)}
                            onChange={() => togglePick(c.id)}
                            className="mt-0.5 shrink-0"
                          />
                          <div className="flex flex-1 items-baseline justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="font-mono text-xs text-neutral-500">
                                {formatDate(c.txnDate)}
                              </div>
                              <div className="truncate text-xs">
                                {c.rawDescription}
                              </div>
                              {c.currentNote && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    // Prevent the wrapping <label> from also
                                    // toggling the checkbox.
                                    e.preventDefault();
                                    e.stopPropagation();
                                    form.setFieldValue("draft", c.currentNote ?? "");
                                  }}
                                  title="Click to copy this note into the textarea"
                                  className="block truncate text-left text-[10px] italic text-amber-700 underline-offset-4 hover:underline dark:text-amber-400"
                                >
                                  current: {c.currentNote} ↑
                                </button>
                              )}
                            </div>
                            <span
                              className={`font-mono text-xs whitespace-nowrap ${
                                c.drCr === "debit"
                                  ? "text-spend"
                                  : "text-inflow"
                              }`}
                            >
                              {formatPaiseSigned(c.amountPaise, c.drCr)}
                            </span>
                          </div>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {candidates && candidates.some((c) => c.currentNote) && picked.size > 0 && (
                <p className="mt-2 text-[10px] text-owed-to-me">
                  Heads up: some checked rows already have a different note —
                  saving will overwrite them.
                </p>
              )}
              {selectionWarning && (
                <p className="mt-2 text-[10px] text-red-600 dark:text-red-400">
                  {selectionWarning}
                </p>
              )}
            </div>
          )}

          {feedback && (
            <p className="mt-2 text-xs text-inflow">
              {feedback}
            </p>
          )}
          {(error || query.error) && <p className="mt-2 text-xs text-red-600">{error ?? query.error?.message}</p>}

          <footer className="mt-5 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={close}
              disabled={pending}
              className="rounded px-3 py-1.5 text-sm text-neutral-600 disabled:opacity-50 dark:text-neutral-400"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {pending
                ? "Saving…"
                : picked.size > 0 && draft.trim().length > 0
                  ? `Save (+${picked.size})`
                  : "Save"}
            </button>
          </footer>
        </div>
      </dialog>
    </>
  );
}
