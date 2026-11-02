import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { backfillCounterparties } from "@/db/counterparty-backfill";
import { ingestStatement } from "@/domain/ingest/pipeline";
import type { ImportSummary } from "@/domain/ingest/dedupe";
import type { ActionSpec } from "@/lib/action/core";
import { Invalid, Unavailable } from "@/lib/action/errors";
import { CurrentUser, query, type Db } from "@/lib/action/services";

/**
 * Statement upload handler behind ./actions.ts.
 *
 * Same steps and messages as the pre-Effect version, except that a failed
 * save no longer echoes the database error (see PersistError below). What
 * changed in the migration itself is how
 * failures travel: the ingest pipeline's tagged errors are mapped with
 * catchTags to typed action errors instead of being folded into an
 * `{ ok: false, error }` value, so the action returns the standard
 * ActionResult. UploadForm turns that back into the panel it always showed.
 */

export type ImportSuccess = {
  summary: ImportSummary;
  bank: string;
  categorizedCount: number;
  needsAttentionCount: number;
  reviewHref: string;
  statementHref: string;
};

// The browser sends the <form> as FormData; its fields are read below exactly
// as before (a file must be a non-empty File; the password is trimmed).
const Upload = Schema.instanceOf(FormData);

export const uploadStatementSpec: ActionSpec<FormData, FormData, ImportSuccess, CurrentUser | Db> = {
  input: Upload,
  revalidate: ["/import", "/transactions"],
  handler: Effect.fn("uploadStatement")(function* (formData) {
    const user = yield* CurrentUser;

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return yield* new Invalid({ message: "No file uploaded", field: "file" });
    }

    const passwordField = formData.get("pdfPassword");
    const pdfPassword =
      typeof passwordField === "string" && passwordField.trim().length > 0
        ? passwordField.trim()
        : undefined;

    const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
    const buf = Buffer.from(yield* Effect.promise(() => file.arrayBuffer()));

    const summary = yield* ingestStatement({
      accountId: account.id,
      filename: file.name,
      mime: file.type || "application/pdf",
      buffer: buf,
      pdfPassword,
    }).pipe(
      Effect.catchTags({
        AdapterNotFound: () =>
          Effect.fail(
            new Invalid({
              message: "No bank adapter recognized this file. Try the generic CSV mapper.",
              field: "file",
            }),
          ),
        PdfPasswordError: (err) =>
          Effect.fail(
            new Invalid({
              message:
                err.reason === "required"
                  ? "This PDF is password-protected. Enter the password from your bank (Bank of Baroda statements often use your date of birth as DDMMYYYY)."
                  : "Incorrect PDF password. Check the password your bank sent with the statement.",
              field: "pdfPassword",
            }),
          ),
        ParseError: (err) =>
          Effect.fail(new Invalid({ message: `Parse failed at ${err.stage}: ${err.detail}`, field: "file" })),
        // The cause is a database error whose text includes the SQL and every
        // row's values (drizzle's "Failed query: ... params: ..."). Until
        // 2026-11-02 it was sent to the browser as "Database error: <cause>".
        // Log it on the server; the user gets a fixed, retryable message.
        PersistError: (err) =>
          Effect.logError("uploadStatement: saving the statement failed", err.cause).pipe(
            Effect.andThen(
              Effect.fail(
                new Unavailable({ message: "We couldn't save this statement. Please try again." }),
              ),
            ),
          ),
      }),
    );

    // Same as before: a backfill failure is logged and doesn't fail the import.
    yield* Effect.tryPromise({
      try: () => backfillCounterparties(account.id, user.id),
      catch: (err) => err,
    }).pipe(
      Effect.catch((err) =>
        Effect.sync(() => console.error("[import] counterparty backfill failed", err)),
      ),
    );

    const [importRow, counts] = yield* Effect.all(
      [
        query((db) =>
          db
            .select({
              periodStart: schema.imports.periodStart,
              periodEnd: schema.imports.periodEnd,
            })
            .from(schema.imports)
            .where(
              and(
                eq(schema.imports.id, summary.importId),
                eq(schema.imports.accountId, account.id),
              ),
            )
            .limit(1),
        ),
        query((db) =>
          db
            .select({
              categorizedCount: sql<number>`count(*) filter (where ${schema.transactions.categoryId} is not null)::int`,
              needsAttentionCount: sql<number>`count(*) filter (where ${schema.transactions.categoryId} is null or ${schema.transactions.needsReview})::int`,
            })
            .from(schema.transactions)
            .where(
              and(
                eq(schema.transactions.accountId, account.id),
                eq(schema.transactions.sourceImportId, summary.importId),
              ),
            ),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const imported = importRow[0];
    const reviewHref = `/transactions?import=${encodeURIComponent(summary.importId)}&attention=1&all=1`;
    const statementHref =
      imported?.periodStart && imported.periodEnd
        ? `/transactions?from=${encodeURIComponent(imported.periodStart)}&to=${encodeURIComponent(imported.periodEnd)}`
        : `/transactions?import=${encodeURIComponent(summary.importId)}&all=1`;

    return {
      summary,
      bank: account.bank,
      categorizedCount: counts[0]?.categorizedCount ?? 0,
      needsAttentionCount: counts[0]?.needsAttentionCount ?? 0,
      reviewHref,
      statementHref,
    };
  }),
};
