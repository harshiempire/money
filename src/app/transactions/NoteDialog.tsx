"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  applyNoteToTransactions,
  getNoteCandidates,
  setTransactionNote,
  type NoteCandidate,
} from "./actions";
import { formatDate, formatPaiseSigned } from "@/lib/format";

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
  const [candidates, setCandidates] = useState<NoteCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const open = () => {
    setDraft(note ?? "");
    setPicked(new Set());
    setFeedback(null);
    setCandidates(null);
    dialogRef.current?.showModal();
  };
  const close = () => dialogRef.current?.close();

  // Lazy-load siblings the first time the dialog opens.
  useEffect(() => {
    if (!hasCounterparty) return;
    const dlg = dialogRef.current;
    if (!dlg) return;
    const onOpen = async () => {
      if (candidates !== null) return;
      const list = await getNoteCandidates({ transactionId });
      setCandidates(list);
    };
    // The native <dialog> doesn't fire an "open" event we can rely on; do it
    // imperatively from `open()` above instead. Kept as effect to react to
    // late mounts.
    if (dlg.open) onOpen();
  });

  const togglePick = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = () => {
    startTransition(async () => {
      await setTransactionNote({ transactionId, note: draft });
      if (picked.size > 0 && draft.trim().length > 0) {
        const r = await applyNoteToTransactions({
          transactionIds: [...picked],
          note: draft,
        });
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
    });
  };

  const hasNote = (note ?? "").trim().length > 0;

  return (
    <>
      <button
        type="button"
        onClick={async () => {
          open();
          if (hasCounterparty && candidates === null) {
            const list = await getNoteCandidates({ transactionId });
            setCandidates(list);
          }
        }}
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
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="e.g. F1 TV subscription"
            className="w-full rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          />

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
                        setPicked(new Set(candidates.map((c) => c.id)))
                      }
                      className="underline-offset-4 hover:underline"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => setPicked(new Set())}
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
                        className="flex items-center gap-2 p-2 hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
                      >
                        <input
                          type="checkbox"
                          checked={picked.has(c.id)}
                          onChange={() => togglePick(c.id)}
                          className="mt-0.5 shrink-0"
                        />
                        <button
                          type="button"
                          onClick={() => togglePick(c.id)}
                          className="flex flex-1 items-baseline justify-between gap-3 text-left"
                        >
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
                                  e.stopPropagation();
                                  setDraft(c.currentNote ?? "");
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
                                ? "text-red-700 dark:text-red-400"
                                : "text-emerald-700 dark:text-emerald-400"
                            }`}
                          >
                            {formatPaiseSigned(c.amountPaise, c.drCr)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {candidates && candidates.some((c) => c.currentNote) && picked.size > 0 && (
                <p className="mt-2 text-[10px] text-amber-700 dark:text-amber-400">
                  Heads up: some checked rows already have a different note —
                  saving will overwrite them.
                </p>
              )}
              {picked.size > 0 && draft.trim().length === 0 && (
                <p className="mt-2 text-[10px] text-red-600 dark:text-red-400">
                  Type the note text above first — checked rows are ignored
                  when the field is empty.
                </p>
              )}
            </div>
          )}

          {feedback && (
            <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
              {feedback}
            </p>
          )}

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
