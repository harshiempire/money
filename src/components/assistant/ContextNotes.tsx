"use client";

import { useState } from "react";
import { deleteContextNote, listContextNotesAction, saveContextNote } from "@/app/assistant/tag-actions";
import type { ContextNote } from "@/lib/assistant/tag-batch";

/** The user's own notes. Saving here is the user editing, not the model. */
export function ContextNotesButton({
  notes,
  onChange,
}: {
  notes: ContextNote[];
  onChange: (notes: ContextNote[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const next = await listContextNotesAction();
    onChange(next);
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await saveContextNote({ body: draft });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDraft("");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-600 hover:bg-neutral-100">
        Notes {notes.length > 0 ? notes.length : ""}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 rounded-md border border-neutral-200 bg-white p-2 text-left shadow-lg">
          <div className="mb-1 text-[11px] font-medium text-neutral-700">Notes Ask Money reads</div>
          <ul className="flex max-h-40 flex-col gap-1 overflow-auto">
            {notes.length === 0 && <li className="text-[11px] text-neutral-500">None yet. A fact like “Swiggy is Food”.</li>}
            {notes.map((note) => (
              <li key={note.id} className="rounded bg-neutral-50 px-2 py-1 text-[12px]">
                {editing === note.id ? (
                  <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={2} maxLength={500} className="w-full rounded border border-neutral-300 px-1 py-0.5 text-[12px]" />
                ) : (
                  <span>{note.body}</span>
                )}
                <div className="mt-1 flex gap-2 text-[10px] uppercase tracking-wide text-neutral-500">
                  {editing === note.id ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        const res = await saveContextNote({ id: note.id, body: editBody });
                        setBusy(false);
                        if (!res.ok) {
                          setError(res.error);
                          return;
                        }
                        setEditing(null);
                        await refresh();
                      }}
                    >
                      Save
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(note.id);
                        setEditBody(note.body);
                      }}
                    >
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={async () => {
                      await deleteContextNote({ id: note.id });
                      await refresh();
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Add a note"
            className="mt-2 w-full rounded border border-neutral-300 px-2 py-1 text-[12px]"
          />
          {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
          <button type="button" disabled={busy || !draft.trim()} onClick={() => void add()} className="mt-1 text-[11px] font-medium text-neutral-800 disabled:opacity-50">
            Save note
          </button>
        </div>
      )}
    </div>
  );
}
