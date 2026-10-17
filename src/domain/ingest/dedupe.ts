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
          rowsNew: 0,
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
