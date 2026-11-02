import { Effect } from "effect";
import {
  AdapterNotFound,
  type ParsedStatement,
  type ParseError,
  type PdfPasswordError,
} from "../canonical";

export interface AdapterContext {
  readonly pdfPassword?: string;
}
import { bobAdapter } from "./bob/parser";

export interface BankAdapter {
  /** Slug used in the DB's `bank` column. */
  readonly name: string;
  detect: (
    file: Buffer,
    mime: string,
    ctx: AdapterContext,
  ) => Effect.Effect<boolean, PdfPasswordError>;
  parse: (
    file: Buffer,
    ctx: AdapterContext,
  ) => Effect.Effect<ParsedStatement, ParseError | PdfPasswordError>;
}

const REGISTRY: readonly BankAdapter[] = [bobAdapter];

export const pickAdapter = (
  file: Buffer,
  mime: string,
  ctx: AdapterContext = {},
): Effect.Effect<BankAdapter, AdapterNotFound | PdfPasswordError> =>
  Effect.gen(function* () {
    for (const adapter of REGISTRY) {
      const matched = yield* adapter.detect(file, mime, ctx);
      if (matched) return adapter;
    }
    return yield* Effect.fail(
      new AdapterNotFound({
        mime,
        hint: "No registered bank adapter recognized the file.",
      }),
    );
  });

export const listAdapters = (): readonly BankAdapter[] => REGISTRY;
