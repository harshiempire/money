"use client";

import { useState, useTransition } from "react";
import { uploadStatement, type ImportResult } from "./actions";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

export function UploadForm() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ImportResult | null>(null);

  return (
    <form
      className="space-y-5"
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
      <div>
        <label className="block text-sm font-medium text-[var(--color-text)]">
          Bank statement PDF
        </label>
        <input
          type="file"
          name="file"
          accept="application/pdf,.pdf"
          required
          className="mt-1.5 block w-full text-sm text-[var(--color-text-secondary)] file:mr-3 file:rounded-[var(--radius-md)] file:border-0 file:bg-[var(--color-surface-overlay)] file:px-4 file:py-2 file:text-sm file:font-medium file:text-[var(--color-text)] hover:file:bg-[var(--color-border)]"
        />
      </div>
      <Input
        label="PDF password (if required)"
        name="pdfPassword"
        type="password"
        autoComplete="off"
        placeholder="e.g. DDMMYYYY for Bank of Baroda"
        hint="Many bank statement PDFs are encrypted. BoB usually uses your date of birth (DDMMYYYY)."
      />
      <Button type="submit" disabled={pending}>
        {pending ? "Importing…" : "Import statement"}
      </Button>

      {result && <ResultPanel result={result} />}
    </form>
  );
}

function ResultPanel({ result }: { result: ImportResult }) {
  if (!result.ok) {
    return (
      <Alert variant="error" title="Import failed">
        {result.error}
      </Alert>
    );
  }
  const { summary, bank } = result;
  return (
    <Alert variant="success" title={`Import complete · ${bank}`}>
      <ul className="space-y-0.5 font-mono text-xs">
        <li>Rows seen: <strong>{summary.rowsSeen}</strong></li>
        <li>Rows new: <strong>{summary.rowsNew}</strong></li>
        <li>Rows already known: <strong>{summary.rowsDuplicate}</strong></li>
      </ul>
    </Alert>
  );
}
