"use server";

import { Effect, Either } from "effect";
import { revalidatePath } from "next/cache";
import { getOrCreateAccountForBank, type BankCode } from "@/db/money-account";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import { ingestStatement } from "@/domain/ingest/pipeline";
import { pickAdapter } from "@/domain/adapters";
import type { ImportSummary } from "@/domain/ingest/dedupe";

export type ImportResult =
  | { ok: true; summary: ImportSummary; bank: string }
  | { ok: false; error: string };

export async function uploadStatement(
  formData: FormData,
): Promise<ImportResult> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "No file uploaded" };
  }

  const passwordField = formData.get("pdfPassword");
  const pdfPassword =
    typeof passwordField === "string" && passwordField.trim().length > 0
      ? passwordField.trim()
      : undefined;

  const user = await requireCurrentUserAction();
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = file.type || "application/pdf";
  const ctx = { pdfPassword };

  // Detect which bank adapter matches the file so we can resolve the right account.
  const detectResult = await Effect.runPromise(
    Effect.either(pickAdapter(buf, mime, ctx)),
  );
  if (Either.isLeft(detectResult)) {
    const err = detectResult.left;
    if (err._tag === "PdfPasswordError") {
      return {
        ok: false,
        error:
          err.reason === "required"
            ? "This PDF is password-protected. Enter the password your bank provided with the statement."
            : "Incorrect PDF password. Check the password your bank sent with the statement.",
      };
    }
    return {
      ok: false,
      error: "No bank adapter recognized this file. Try the generic CSV mapper.",
    };
  }

  const bank = detectResult.right.name as BankCode;
  const account = await getOrCreateAccountForBank(user.id, bank);

  const result = await Effect.runPromise(
    Effect.either(
      ingestStatement({
        accountId: account.id,
        filename: file.name,
        mime,
        buffer: buf,
        pdfPassword,
      }),
    ),
  );

  if (Either.isLeft(result)) {
    const err = result.left;
    const msg =
      err._tag === "AdapterNotFound"
        ? "No bank adapter recognized this file. Try the generic CSV mapper."
        : err._tag === "PdfPasswordError"
          ? err.reason === "required"
            ? "This PDF is password-protected. Enter the password your bank provided with the statement."
            : "Incorrect PDF password. Check the password your bank sent with the statement."
          : err._tag === "ParseError"
            ? `Parse failed at ${err.stage}: ${err.detail}`
            : `Database error: ${String((err as { cause?: unknown }).cause ?? "unknown")}`;
    return { ok: false, error: msg };
  }

  revalidatePath("/import");
  revalidatePath("/transactions");
  return { ok: true, summary: result.right, bank: account.bank };
}
