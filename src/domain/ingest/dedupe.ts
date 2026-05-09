import "server-only";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { PersistError, type CanonicalTxn } from "../canonical";

export interface ImportSummary {
  importId: string;
  rowsSeen: number;
  rowsNew: number;
  rowsDuplicate: number;
}

/**
 * Stable fallback ref for rows whose adapter couldn't extract one (e.g. the
 * synthetic Opening Balance row, or banks that omit refs).
 */
const fallbackRefId = (txn: CanonicalTxn): string => {
  const h = createHash("sha256");
  h.update(`${txn.txnDate}|${txn.amountPaise}|${txn.drCr}|${txn.rawDescription}`);
  return `fallback:${h.digest("hex").slice(0, 24)}`;
};

const fileSha256 = (buf: Buffer): string =>
  createHash("sha256").update(buf).digest("hex");

interface PersistInput {
  accountId: string;
  bank: string;
  filename: string;
  fileBuffer: Buffer;
  periodStart: string | null;
  periodEnd: string | null;
  rows: readonly CanonicalTxn[];
}

/**
 * Insert one Import row and the associated transactions in a single round-trip,
 * relying on the `(account_id, ref_id)` unique index to swallow duplicates.
 *
 * Returns counts so the UI can show "115 rows seen, 87 already known, 28 new".
 */
export const persistImport = (
  input: PersistInput,
): Effect.Effect<ImportSummary, PersistError> =>
  Effect.tryPromise({
    try: async () => {
      const sha = fileSha256(input.fileBuffer);
      const [importRow] = await db
        .insert(schema.imports)
        .values({
          accountId: input.accountId,
          filename: input.filename,
          sha256: sha,
          bank: input.bank,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          rowsSeen: input.rows.length,
          rowsNew: 0, // Updated below.
        })
        .returning({ id: schema.imports.id });

      const importId = importRow.id;

      const values = input.rows.map((r) => ({
        accountId: input.accountId,
        txnDate: r.txnDate,
        valueDate: r.valueDate,
        amountPaise: r.amountPaise,
        drCr: r.drCr,
        channel: r.channel,
        refId: r.refId ?? fallbackRefId(r),
        rawDescription: r.rawDescription,
        parsedPurpose: r.parsedPurpose,
        balancePaise: r.balancePaise,
        sourceImportId: importId,
        rawPayload: r.rawPayload,
      }));

      let rowsNew = 0;
      if (values.length > 0) {
        // The unique index on (account_id, ref_id) is what enforces dedup.
        // `onConflictDoNothing` returns only the rows that were actually
        // inserted, so its length is `rowsNew`.
        const inserted = await db
          .insert(schema.transactions)
          .values(values)
          .onConflictDoNothing({
            target: [
              schema.transactions.accountId,
              schema.transactions.refId,
              schema.transactions.drCr,
            ],
          })
          .returning({ id: schema.transactions.id });
        rowsNew = inserted.length;
      }

      await db
        .update(schema.imports)
        .set({ rowsNew })
        .where(sql`${schema.imports.id} = ${importId}`);

      return {
        importId,
        rowsSeen: input.rows.length,
        rowsNew,
        rowsDuplicate: input.rows.length - rowsNew,
      } satisfies ImportSummary;
    },
    catch: (cause) => new PersistError({ cause }),
  });
