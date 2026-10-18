import { Result, Schema } from "effect";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
import { transactionRef } from "./refs";
import type { ListTransactionsInput } from "./schemas";
import { transactionView, validatePayeeFilter, type McpTransaction } from "./view";

const Cursor = Schema.Struct({ after: Schema.String.check(Schema.isPattern(/^txn_[A-Za-z0-9_-]{22}$/)) });
export class McpToolError extends Error {}

export function pageTransactions(
  rows: McpTransaction[],
  input: ListTransactionsInput,
  actor: MoneyActor,
  key: Uint8Array,
) {
  let payee: string | undefined;
  try {
    payee = validatePayeeFilter(input.payee);
  } catch {
    throw new McpToolError("Use a payee name without a handle or a number with five or more digits.");
  }
  const views = rows
    .filter(
      (r) =>
        (!input.month || r.txnDate.startsWith(`${input.month}-`)) &&
        (!input.uncategorized || r.category === null),
    )
    .sort((a, b) => b.txnDate.localeCompare(a.txnDate) || b.id.localeCompare(a.id))
    .map((r) => transactionView(r, transactionRef(key, actor.userId, r.id)))
    .filter((r) => !payee || r.payee.toLowerCase().includes(payee));
  let start = 0;
  if (input.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(input.cursor)) throw new Error();
      const bytes = Buffer.from(input.cursor, "base64url");
      if (bytes.toString("base64url") !== input.cursor) throw new Error();
      const raw: unknown = JSON.parse(bytes.toString("utf8"));
      const decoded = Schema.decodeUnknownResult(Cursor)(raw);
      if (Result.isFailure(decoded)) throw new Error();
      const index = views.findIndex((v) => v.ref === decoded.success.after);
      if (index < 0) throw new Error();
      start = index + 1;
    } catch {
      throw new McpToolError(
        "That cursor is no longer available. Start with a new list_transactions request.",
      );
    }
  }
  const transactions = views.slice(start, start + (input.limit ?? 50));
  const last = transactions.at(-1);
  const next_cursor =
    last && start + transactions.length < views.length
      ? Buffer.from(JSON.stringify({ after: last.ref })).toString("base64url")
      : null;
  return {
    transactions,
    next_cursor,
  };
}
