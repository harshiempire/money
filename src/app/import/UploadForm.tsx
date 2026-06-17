"use client";

import { useState, useTransition } from "react";
import { uploadStatement, type ImportResult } from "./actions";

export function UploadForm() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ImportResult | null>(null);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(async () => {
          setResult(null);
          const r = await uploadStatement(fd);
          setResult(r);
        });
      }}
    >
      <label className="block">
        <span className="block text-sm font-medium">Bank statement PDF</span>
        <input
          type="file"
          name="file"
          accept="application/pdf,.pdf"
          required
          className="mt-1 block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-neutral-200 file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-neutral-300 dark:file:bg-neutral-800 dark:hover:file:bg-neutral-700"
        />
      </label>
      <label className="block">
        <span className="block text-sm font-medium">PDF password (if required)</span>
        <input
          type="password"
          name="pdfPassword"
          autoComplete="off"
          placeholder="Leave blank if not required"
          className="mt-1 block w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <span className="mt-1 block text-xs text-neutral-500">
          Some bank PDFs are password-protected. Bank of Baroda typically uses
          your date of birth (DDMMYYYY).
        </span>
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {pending ? "Importing…" : "Import"}
      </button>

      {result && <ResultPanel result={result} />}
    </form>
  );
}

function ResultPanel({ result }: { result: ImportResult }) {
  if (!result.ok) {
    return (
      <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        <strong>Import failed.</strong> {result.error}
      </div>
    );
  }
  const { summary, bank } = result;
  return (
    <div className="rounded border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
      <p className="font-medium">Import complete · {bank}</p>
      <ul className="mt-2 space-y-0.5">
        <li>
          rows seen: <strong>{summary.rowsSeen}</strong>
        </li>
        <li>
          rows new: <strong>{summary.rowsNew}</strong>
        </li>
        <li>
          rows already known:{" "}
          <strong>{summary.rowsDuplicate}</strong>
        </li>
      </ul>
    </div>
  );
}
