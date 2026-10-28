"use client";
import { useRef, useState } from "react";
import { listLedgerChanges, undoLedgerChange } from "./actions";
const changeDateFormat = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});
type Changes = Awaited<ReturnType<typeof listLedgerChanges>>;
export function RecentChanges({ initial }: { initial: Changes }) {
  const [changes, setChanges] = useState(initial);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  async function undo(id: string) {
    if (saving.current || confirm !== id) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await undoLedgerChange({ changeId: id });
      if (!result.ok) {
        setError(result.error ?? "Couldn't undo this change.");
        return;
      }
      setConfirm(null);
      setChanges(await listLedgerChanges());
    } catch {
      setError("Couldn't confirm whether Undo finished. Reload this page before trying again.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="mt-8 space-y-3" aria-label="Recent changes">
      <h2 className="text-lg font-semibold">Recent changes</h2>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {!changes.available ? (
        <p className="text-sm text-neutral-500">Changes will appear after migration 0014.</p>
      ) : !changes.rows.length ? (
        <p className="text-sm text-neutral-500">No changes yet.</p>
      ) : (
        <ul className="space-y-3">
          {changes.rows.map((row) => (
            <li
              key={row.id}
              className="rounded border border-neutral-300 p-3 text-sm dark:border-neutral-700"
            >
              <p>{row.summary || row.kind.replaceAll("_", " ")}</p>
              <p className="mt-1 text-xs text-neutral-500">
                <time dateTime={row.at}>{changeDateFormat.format(new Date(row.at))}</time>
                {" · "}
                {row.by}
                {" · "}
                {row.count} {row.count === 1 ? "row" : "rows"}
              </p>
              {row.undone ? (
                <p className="mt-2 text-xs text-neutral-500">Undone</p>
              ) : confirm === row.id ? (
                <div className="mt-2 space-x-3">
                  <p className="mb-2">
                    Undo this entire change? This only works if its values have stayed the same.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void undo(row.id)}
                    className="rounded border px-3 py-2 disabled:opacity-50"
                  >
                    {busy ? "Undoing…" : "Confirm Undo"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busy || row.count === 0}
                  onClick={() => {
                    setConfirm(row.id);
                    setError(null);
                  }}
                  className="mt-2 rounded border px-3 py-2 disabled:opacity-50"
                >
                  Undo
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
