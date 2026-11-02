import { McpServer, type CallToolResult, type McpRequestContext } from "@modelcontextprotocol/server";
import { Result, Schema } from "effect";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
import type { McpPrincipal } from "./auth";
import { McpScope, scopeAllows } from "./token";
import { LedgerError } from "@/lib/ledger/context";
import type { McpWriteOps } from "./write-ops";
import { UpdateInput, PayeeInput, ChangesInput, UndoInput, WriteOutput, ChangesOutput } from "./write-schemas";
import { transactionRef } from "./refs";
import { validateTagProposal, type StoredTagRow } from "./proposal";
import { McpToolError, pageTransactions } from "./pagination";
import type { McpTransaction } from "./view";
import {
  CategoriesOutput,
  EmptyInput,
  ListTransactionsInput,
  PeriodInput,
  OverviewOutput,
  type Overview,
  NotesOutput,
  ProposeInput,
  ProposeOutput,
  SummaryOutput,
  TransactionsOutput,
  type PeriodSummary,
} from "./schemas";

export interface McpOps {
  listCategories(actor: MoneyActor): Promise<
    Array<{
      id: string;
      name: string;
      kind: string;
    }>
  >;
  listTransactions(actor: MoneyActor, input: ListTransactionsInput): Promise<McpTransaction[]>;
  overview(actor: MoneyActor): Promise<Overview>;
  periodSummary(actor: MoneyActor, input: PeriodInput): Promise<PeriodSummary>;
  standingNotes(actor: MoneyActor): Promise<string[]>;
  transactionIds(actor: MoneyActor): Promise<string[]>;
  proposalTransactions(
    actor: MoneyActor,
    ids: string[],
  ): Promise<
    Array<{
      id: string;
      categoryId: string | null;
    }>
  >;
  storeDraft(
    principal: McpPrincipal,
    input: {
      rows: StoredTagRow[];
      title: string | null;
      rejectedCount: number;
    },
  ): Promise<void>;
}
const Principal = Schema.Struct({
  actor: Schema.Struct({
    userId: Schema.NonEmptyString,
    accountId: Schema.NonEmptyString,
  }),
  scope: McpScope,
  tokenId: Schema.NonEmptyString,
  label: Schema.String,
});

export function principalFromContext(ctx: McpRequestContext): McpPrincipal {
  const principal = ctx.authInfo?.extra?.principal;
  if (
    !Schema.is(Principal)(principal) ||
    ctx.authInfo?.clientId !== principal.tokenId ||
    !ctx.authInfo.scopes.includes(principal.scope)
  )
    throw new Error("MCP authentication is required.");
  return principal;
}

const standard = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));
function result(value: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: value,
    content: [
      {
        type: "text",
        text: JSON.stringify(value),
      },
    ],
  };
}
async function safely(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            error instanceof LedgerError
              ? `${error.code}: ${error.message}`
              : error instanceof McpToolError
              ? error.message
              : "Money couldn't complete that request. Try again.",
        },
      ],
    };
  }
}

export function buildMcpServer(principal: McpPrincipal, ops: McpOps, key: Uint8Array, revKey: Uint8Array, writes?: McpWriteOps): McpServer {
  const server = new McpServer(
    {
      name: "money",
      version: "1.0.0",
    },
    {
      instructions:
        "Start with get_overview. Never assume a month; look across months or all time when needed. " +
        "Amounts are exact rupee strings; never do money math in your head, use tool results. " +
        "A person can have several UPI handles; do not assume one handle identifies all their payments. " +
        "Never bypass the MCP with DB scripts, app internals or .env files. If a tool is missing, say so. " +
        (principal.scope === "write"
          ? "Write tools change this account directly. Before writing, read current refs and revs. Use a fresh idempotency key per request; reuse it only for an identical retry. Afterwards report what changed and the change id for undo_change or Connections. "
          : "Read access to this account. ") +
        "propose_tags stays draft-only; nothing changes until the owner presses Apply in Money.",
    },
  );
  const actor = principal.actor;
  const read = { readOnlyHint: true };
  server.registerTool(
    "get_overview",
    {
      title: "Get account overview",
      description: "Call this first. Read the transaction date range, oldest-first monthly counts and exact paid/received totals, uncategorized counts, split counts and open shares, plus all-time totals and people with open balances.",
      inputSchema: standard(EmptyInput),
      outputSchema: standard(OverviewOutput),
      annotations: read,
    },
    () => safely(async () => result(await ops.overview(actor))),
  );
  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description:
        "List full category names and kinds for this account. Use these exact names in propose_tags.",
      inputSchema: standard(EmptyInput),
      outputSchema: standard(CategoriesOutput),
      annotations: read,
    },
    () =>
      safely(async () => {
        const categories = (await ops.listCategories(actor)).map(({ name, kind }) => ({ name, kind }));
        return result({ categories });
      }),
  );
  server.registerTool(
    "list_transactions",
    {
      title: "List transactions",
      description:
        "List full transactions by month OR inclusive from/to, or neither for all time, up to 100 per page. " +
        "Filter by direction, exact category, uncategorized status or a substring of payee, handle or raw description. " +
        "Returns opaque refs/revs and exact rupee strings; no database ids.",
      inputSchema: standard(ListTransactionsInput),
      outputSchema: standard(TransactionsOutput),
      annotations: read,
    },
    (input) =>
      safely(async () => {
        return result(pageTransactions(await ops.listTransactions(actor, input), input, actor, key, revKey));
      }),
  );
  server.registerTool(
    "get_period_summary",
    {
      title: "Get period summary",
      description:
        "Read spending totals, category breakdown and triage counts for a month OR inclusive from/to; neither means all time. " +
        "Money amounts are exact rupee strings.",
      inputSchema: standard(PeriodInput),
      outputSchema: standard(SummaryOutput),
      annotations: read,
    },
    (input) => safely(async () => result(await ops.periodSummary(actor, input))),
  );
  server.registerTool(
    "list_standing_notes",
    {
      title: "List standing notes",
      description:
        "Read the owner's full standing notes for interpreting transactions.",
      inputSchema: standard(EmptyInput),
      outputSchema: standard(NotesOutput),
      annotations: read,
    },
    () =>
      safely(async () => {
        return result({ notes: await ops.standingNotes(actor) });
      }),
  );
  if (scopeAllows(principal.scope, "propose")) {
    server.registerTool(
      "propose_tags",
      {
        title: "Propose tags",
        description:
          "Propose categories only for uncategorized transactions, up to 100 rows. Each row: { ref (from " +
          "list_transactions), category (exact name from list_categories), confidence? (high|medium|low), " +
          "reason? (short) }. Bad rows are rejected individually with codes: invalid_row, unknown_ref, " +
          "duplicate_ref, unknown_category, already_categorized. Nothing is saved until the owner presses " +
          "Apply in Money.",
        inputSchema: standard(ProposeInput),
        outputSchema: standard(ProposeOutput),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
        },
      },
      (input) =>
        safely(async () => {
          const [ids, categories] = await Promise.all([ops.transactionIds(actor), ops.listCategories(actor)]);
          const refs = new Map(ids.map((id) => [transactionRef(key, actor.userId, id), id]));
          const requested = new Set<string>();
          for (const row of input.rows) {
            const parsed = Schema.decodeUnknownResult(Schema.Struct({ ref: Schema.String }))(row);
            if (Result.isSuccess(parsed)) {
              const id = refs.get(parsed.success.ref);
              if (id) requested.add(id);
            }
          }
          const transactions = new Map(
            (await ops.proposalTransactions(actor, [...requested])).map((t) => [
              transactionRef(key, actor.userId, t.id),
              t,
            ]),
          );
          const { accepted, rejected } = validateTagProposal(input.rows, {
            transactions,
            categories,
          });
          if (accepted.length)
            await ops.storeDraft(principal, {
              rows: accepted,
              title: input.title ?? null,
              rejectedCount: rejected.length,
            });
          return result({
            draft_stored: accepted.length > 0,
            accepted: accepted.length,
            rejected,
            next_step: "Open Money and press Apply in Ask Money → proposed tags. Nothing has been saved yet.",
          });
        }),
    );
  }
  if (scopeAllows(principal.scope, "write")) {
    server.registerTool("update_transactions", {
      title: "Update transactions", description: "Edit categories, notes and flags for 1–100 transactions. All rows succeed together or nothing changes. Read current refs and revs first; stale errors include current_rev. Every change can be undone.",
      inputSchema: standard(UpdateInput), outputSchema: standard(WriteOutput), annotations: { readOnlyHint: false, destructiveHint: false },
    }, (input) => safely(async () => result(await requireWrites().update(principal, input))));
    server.registerTool("set_payee_default", {
      title: "Set payee default", description: "Set or clear a payee's default category using a transaction ref. current_default must name the present default (null for none) to confirm replacement. Other transactions stay unchanged.",
      inputSchema: standard(PayeeInput), outputSchema: standard(WriteOutput), annotations: { readOnlyHint: false, destructiveHint: false },
    }, (input) => safely(async () => result(await requireWrites().payee(principal, input))));
    server.registerTool("list_changes", {
      title: "List recent changes", description: "Read the newest changes from the app and agents, including change ids for Undo and full reasons. Newest first, up to 50 per page.",
      inputSchema: standard(ChangesInput), outputSchema: standard(ChangesOutput), annotations: read,
    }, (input) => safely(async () => result(await requireWrites().changes(principal, input))));
    server.registerTool("undo_change", {
      title: "Undo a change", description: "Undo every target of a change together. Refused if a target changed since, or the change was already undone. Undoing an undo restores its previous values.",
      inputSchema: standard(UndoInput), outputSchema: standard(WriteOutput), annotations: { readOnlyHint: false, destructiveHint: false },
    }, (input) => safely(async () => result(await requireWrites().undo(principal, input))));
  }
  function requireWrites(): McpWriteOps {
    if (!writes) throw new McpToolError("Write operations aren't available.");
    return writes;
  }
  return server;
}
