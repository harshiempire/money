import { McpServer, type CallToolResult, type McpRequestContext } from "@modelcontextprotocol/server";
import { Result, Schema } from "effect";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
import { modelSafeText } from "@/lib/assistant/model-view";
import { standingNotesForModel } from "@/lib/assistant/tag-batch";
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
  MonthInput,
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
  periodSummary(actor: MoneyActor, month?: string): Promise<PeriodSummary>;
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
        principal.scope === "write"
          ? "Access to one Money account. Write tools change categories, notes, flags and payee defaults directly. Read current refs and revs first. Every write requires an idempotency key; reuse it only for the identical request. Changes can be undone with undo_change or from Connections. propose_tags still only stores a review draft."
          : "Read access to one Money account. propose_tags only stores a draft; nothing changes until the owner presses Apply in Money.",
    },
  );
  const actor = principal.actor;
  const read = { readOnlyHint: true };
  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description:
        "List safe category names and kinds for this account. Use these exact names in propose_tags.",
      inputSchema: standard(EmptyInput),
      outputSchema: standard(CategoriesOutput),
      annotations: read,
    },
    () =>
      safely(async () => {
        const categories = (await ops.listCategories(actor)).flatMap((c) => {
          const name = modelSafeText(c.name, c.name.length);
          return name
            ? [
                {
                  name,
                  kind: modelSafeText(c.kind) ?? "spend",
                },
              ]
            : [];
        });
        return result({ categories });
      }),
  );
  server.registerTool(
    "list_transactions",
    {
      title: "List transactions",
      description:
        "List transactions filtered by month, uncategorized status or payee, up to 100 per page. Returns " +
        "opaque refs and amounts as exact rupee strings. Payee is a redacted display name; its filter " +
        "searches only that safe name.",
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
        "Read spending totals, category breakdown and triage counts for a month or the default period. " +
        "Money amounts are exact rupee strings.",
      inputSchema: standard(MonthInput),
      outputSchema: standard(SummaryOutput),
      annotations: read,
    },
    (input) => safely(async () => result(await ops.periodSummary(actor, input.month))),
  );
  server.registerTool(
    "list_standing_notes",
    {
      title: "List standing notes",
      description:
        "Read the owner's safe standing notes for interpreting transactions; reports how many notes were " +
        "omitted by redaction.",
      inputSchema: standard(EmptyInput),
      outputSchema: standard(NotesOutput),
      annotations: read,
    },
    () =>
      safely(async () => {
        const all = await ops.standingNotes(actor);
        const notes = standingNotesForModel(all);
        return result({
          notes,
          omitted: all.length - notes.length,
        });
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
              title: modelSafeText(input.title, 60),
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
      title: "List recent changes", description: "Read the newest changes from the app and agents, including change ids for Undo and redacted reasons. Newest first, up to 50 per page.",
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
