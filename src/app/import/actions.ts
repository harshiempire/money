"use server";

import { Effect, Either } from "effect";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import { ingestStatement } from "@/domain/ingest/pipeline";
import type { ImportSummary } from "@/domain/ingest/dedupe";
import { backfillCounterparties } from "@/db/counterparty-backfill";

export type ImportResult =
  | {
      ok: true;
      summary: ImportSummary;
      bank: string;
      categorizedCount: number;
      needsAttentionCount: number;
      reviewHref: string;
      statementHref: string;
    }
  | { ok: false; error: string };

export async function uploadStatement(
  formData: FormData,
): Promise<ImportResult> {
  const user = await requireCurrentUserAction();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "No file uploaded" };
  }

  const passwordField = formData.get("pdfPassword");
  const pdfPassword =
    typeof passwordField === "string" && passwordField.trim().length > 0
      ? passwordField.trim()
      : undefined;

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

  const [importRow, counts] = await Promise.all([
    db
      .select({
        periodStart: schema.imports.periodStart,
        periodEnd: schema.imports.periodEnd,
      })
      .from(schema.imports)
      .where(
        and(
          eq(schema.imports.id, result.right.importId),
          eq(schema.imports.accountId, account.id),
        ),
      )
      .limit(1),
    db
      .select({
        categorizedCount: sql<number>`count(*) filter (where ${schema.transactions.categoryId} is not null)::int`,
        needsAttentionCount: sql<number>`count(*) filter (where ${schema.transactions.categoryId} is null or ${schema.transactions.needsReview})::int`,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.accountId, account.id),
          eq(schema.transactions.sourceImportId, result.right.importId),
        ),
      ),
  ]);

  const imported = importRow[0];
  const reviewHref = `/transactions?import=${encodeURIComponent(result.right.importId)}&attention=1&all=1`;
  const statementHref =
    imported?.periodStart && imported.periodEnd
      ? `/transactions?from=${encodeURIComponent(imported.periodStart)}&to=${encodeURIComponent(imported.periodEnd)}`
      : `/transactions?import=${encodeURIComponent(result.right.importId)}&all=1`;

  revalidatePath("/import");
  revalidatePath("/transactions");
  return {
    ok: true,
    summary: result.right,
    bank: account.bank,
    categorizedCount: counts[0]?.categorizedCount ?? 0,
    needsAttentionCount: counts[0]?.needsAttentionCount ?? 0,
    reviewHref,
    statementHref,
  };
}
