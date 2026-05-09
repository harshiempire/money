"use server";

import { Effect, Either } from "effect";
import { revalidatePath } from "next/cache";
import { ensureDefaultBobAccount } from "@/db/seed-account";
import { ingestStatement } from "@/domain/ingest/pipeline";
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

  const account = await ensureDefaultBobAccount();
  const buf = Buffer.from(await file.arrayBuffer());

  const result = await Effect.runPromise(
    Effect.either(
      ingestStatement({
        accountId: account.id,
        filename: file.name,
        mime: file.type || "application/pdf",
        buffer: buf,
      }),
    ),
  );

  if (Either.isLeft(result)) {
    const err = result.left;
    const msg =
      err._tag === "AdapterNotFound"
        ? "No bank adapter recognized this file. Try the generic CSV mapper."
        : err._tag === "ParseError"
          ? `Parse failed at ${err.stage}: ${err.detail}`
          : `Database error: ${String((err as { cause?: unknown }).cause ?? "unknown")}`;
    return { ok: false, error: msg };
  }

  revalidatePath("/import");
  revalidatePath("/transactions");
  return { ok: true, summary: result.right, bank: account.bank };
}
