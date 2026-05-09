import "server-only";
import { Effect } from "effect";
import {
  AdapterNotFound,
  ParseError,
  PersistError,
} from "../canonical";
import { pickAdapter } from "../adapters";
import { persistImport, type ImportSummary } from "./dedupe";

export interface IngestInput {
  accountId: string;
  filename: string;
  mime: string;
  buffer: Buffer;
}

/**
 * upload → pickAdapter → adapter.parse → persistImport (with dedup).
 *
 * Each stage is a tagged Effect, so callers can pattern-match on the failure
 * type to render targeted UI feedback (wrong bank, parser bug, DB error).
 */
export const ingestStatement = (
  input: IngestInput,
): Effect.Effect<
  ImportSummary,
  AdapterNotFound | ParseError | PersistError
> =>
  Effect.gen(function* () {
    const adapter = yield* pickAdapter(input.buffer, input.mime);
    const parsed = yield* adapter.parse(input.buffer);
    return yield* persistImport({
      accountId: input.accountId,
      bank: adapter.name,
      filename: input.filename,
      fileBuffer: input.buffer,
      periodStart: parsed.meta.periodStart,
      periodEnd: parsed.meta.periodEnd,
      rows: parsed.rows,
    });
  });
