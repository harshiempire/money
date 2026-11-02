import { Schema } from "effect";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
import type { Snapshot } from "./rules";
export type WriteContext = (
  | { actor: MoneyActor; source: "app" }
  | { actor: MoneyActor; source: "mcp"; tokenId: string; label: string }
) & {
  summary?: string;
  /** MCP adapters compute allocations from this actor-scoped snapshot. Recheck under locks. */
  expectedRelations?: Snapshot;
  transactionRevs?: Record<string, string>;
  idempotency?: {
    key: string;
    requestHash: string;
    renderResult?: (result: unknown) => Record<string, unknown>;
  };
};
export const LedgerErrorCode = Schema.Literals([
  "invalid_input",
  "invalid_row",
  "invalid_cursor",
  "not_found",
  "stale",
  "idempotency_conflict",
  "limit_reached",
  "migration_required",
  "unavailable",
  "already_undone",
  "unknown_category",
  "invalid_category",
  "invalid_amount",
  "unknown_person",
  "split_gap",
  "over_allocation",
  "invalid_source",
  "duplicate_person",
  "existing_split",
  "settled_split",
  "net_event",
  "explained_inflow",
  "fully_allocated",
  "invalid_target",
  "no_open_shares",
  "no_fields",
  "no_payee",
]);
export type LedgerErrorCode = typeof LedgerErrorCode.Type;

export class LedgerError extends Schema.TaggedError<LedgerError>()("LedgerError", {
  code: LedgerErrorCode,
  message: Schema.String,
  current_rev: Schema.optionalKey(Schema.String),
}) {}
export const migrationMessage = "Run migration 0014 before using the change log or MCP writes.";
