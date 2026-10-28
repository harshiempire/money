import { Schema } from "effect";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
export type WriteContext = (
  | { actor: MoneyActor; source: "app" }
  | { actor: MoneyActor; source: "mcp"; tokenId: string; label: string }
) & {
  idempotency?: {
    key: string;
    requestHash: string;
    renderResult?: (result: unknown) => Record<string, unknown>;
  };
};
export class LedgerError extends Schema.TaggedError<LedgerError>()("LedgerError", {
  code: Schema.String,
  message: Schema.String,
}) {}
export const migrationMessage = "Run migration 0014 before using the change log or MCP writes.";
