"use server";

import { Effect, Either } from "effect";
import { revalidatePath } from "next/cache";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import { ingestStatement } from "@/domain/ingest/pipeline";
import type { ImportSummary } from "@/domain/ingest/dedupe";
import { backfillCounterparties } from "@/db/counterparty-backfill";

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
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const buf = Buffer.from(await file.arrayBuffer());

  const result = await Effect.runPromise(
    Effect.either(
      ingestStatement({
        accountId: account.id,
        filename: file.name,
        mime: file.type || "application/pdf",
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
            ? "This PDF is password-protected. Enter the password from your bank (Bank of Baroda statements often use your date of birth as DDMMYYYY)."
            : "Incorrect PDF password. Check the password your bank sent with the statement."
          : err._tag === "ParseError"
            ? `Parse failed at ${err.stage}: ${err.detail}`
            : `Database error: ${String((err as { cause?: unknown }).cause ?? "unknown")}`;
    return { ok: false, error: msg };
  }

  try {
    await backfillCounterparties(account.id, user.id);
  } catch (err) {
    console.error("[import] counterparty backfill failed", err);
  }

  revalidatePath("/import");
  revalidatePath("/transactions");
  return { ok: true, summary: result.right, bank: account.bank };
}
