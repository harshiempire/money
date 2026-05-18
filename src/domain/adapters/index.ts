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
  /** Quick sniff to decide whether this adapter should handle the file. */
  detect: (
    file: Buffer,
    mime: string,
    ctx: AdapterContext,
  ) => Effect.Effect<boolean, PdfPasswordError>;
  /** Parse the file into the canonical shape, or fail with ParseError. */
  parse: (
    file: Buffer,
    ctx: AdapterContext,
  ) => Effect.Effect<ParsedStatement, ParseError | PdfPasswordError>;
}

const REGISTRY: readonly BankAdapter[] = [bobAdapter];

/**
 * Walk the registry and return the first adapter whose `detect` says yes.
 * Fails with AdapterNotFound when nothing matches — caller should then
 * route the user to the generic CSV column-mapper UI.
 */
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
