import { McpServer, type CallToolResult, type McpRequestContext } from "@modelcontextprotocol/server";
import { Result, Schema } from "effect";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
import type { McpPrincipal } from "./auth";
import { McpScope, scopeAllows } from "./token";
import { LedgerError } from "@/lib/ledger/context";
import type { McpWriteOps } from "./write-ops";
import { UpdateInput, PayeeInput, ChangesInput, UndoInput, WriteOutput, ChangesOutput } from "./write-schemas";
import { RelationalInputs, RelationalOutput, RelationalDescriptions, type RelationalTool } from "./relational-schemas";
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

import type { McpReadModel } from "./read-model";
import { buildReadView, getTransactions, getOpenBalances, pagePayees } from "./model-view";
import { suggestCategories, reviewPeriod, SuggestCategoriesOutput, ReviewPeriodOutput } from "./period-review";
import { findPayments } from "./find-payments";
import { buildMcpQueryTables, describeMcpTable, formatMcpQueryResult } from "./query-tables";
import { createQuerySandbox } from "@/lib/assistant/query-sandbox";
import {
  GetTransactionsInput, GetTransactionsOutput, PeopleOutput, OpenBalancesInput, OpenBalancesOutput,
  PayeesInput, PayeesOutput, FindPaymentsInput, FindPaymentsOutput,
  QueryInput, QueryOutput, DescribeTableInput, DescribeTableOutput,
} from "./read-schemas";

export interface McpOps {
  readModel(actor: MoneyActor): Promise<McpReadModel>;
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
        "Prefer get_open_balances, find_payments, get_transactions and list_people; use query for questions those tools do not answer. " +
        "Amounts are exact rupee strings; never do money math in your head, use tool results. " +
        "A person can have several UPI handles; do not assume one handle identifies all their payments. " +
        "Never bypass the MCP with DB scripts, app internals or .env files. If a tool is missing, say so. " +
        (principal.scope === "write"
          ? "Write tools change this account directly. Before writing, read current refs and revs; split replacement/deletion also requires the current split_rev. Use a fresh idempotency key per request; reuse it only for an identical retry. Afterwards report what changed and the change id for undo_change or Connections. For splits and settlements, one clear match means act and name it; several means ask; settle oldest-first unless the owner named a bill. "
          : "Read access to this account. ") +
        "Confirm person↔payee links with the owner before link_person; use suggest_categories for new statements and review_period for what did I miss. " +
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
  const loadView = async () => buildReadView(await ops.readModel(actor), actor, key, revKey);
  server.registerTool("suggest_categories", {
    title: "Suggest sure categories", description: "Read uncategorized bank rows for a month OR inclusive from/to (neither means all time). Deterministic suggestions only: payee default, earlier same-payee history or an explicit category in the owner note. Conflicts are not sure. Save sure rows with update_transactions and report the change id; ask the owner about unsure_groups, largest first.",
    inputSchema: standard(PeriodInput), outputSchema: standard(SuggestCategoriesOutput), annotations: read,
  }, input => safely(async () => {
    const [view, categories] = await Promise.all([loadView(), ops.listCategories(actor)]);
    return result(suggestCategories(view, categories, input));
  }));
  server.registerTool("review_period", {
    title: "Review a period", description: "What did I miss: uncategorized bank rows, open shares on bills in the period, unexplained inflows from confirmed or learned payees, and repeated exact amounts with no note or category (3 in period or 2 from one payee). Month OR inclusive from/to; neither means all time. Each list includes count and refs. Offer to fix one list at a time.",
    inputSchema: standard(PeriodInput), outputSchema: standard(ReviewPeriodOutput), annotations: read,
  }, input => safely(async () => result(reviewPeriod(await loadView(), input))));
  server.registerTool("get_transactions", {
    title: "Get transaction details", description: "Read 1–50 txn_ refs with the full bank view, split_rev (none when unsplit), splits, participant shares, every settlement allocation, linked net event and sourced owed expenses. Unknown refs are listed without failing the batch.",
    inputSchema: standard(GetTransactionsInput), outputSchema: standard(GetTransactionsOutput), annotations: read,
  }, (input) => safely(async () => result(getTransactions(await loadView(), input.refs))));
  server.registerTool("list_people", {
    title: "List people and learned handles", description: "Read every saved or historical person, confirmed linked_payees, suggested_payees with reasons, open balances, share count and last activity. seen_handles are learned from settlements, not confirmed: a person may pay from several keys and one key may pay for several people.",
    inputSchema: standard(EmptyInput), outputSchema: standard(PeopleOutput), annotations: read,
  }, () => safely(async () => result({ people: (await loadView()).people })));
  server.registerTool("get_open_balances", {
    title: "Get open balances", description: "Read outstanding split shares (they owe you) and user-owned owed expenses (you owe them), with oldest-first lines and up to 20 newest unlinked credits from confirmed or learned handles per person. Optional person is a case-insensitive exact name; unknown names return close names.",
    inputSchema: standard(OpenBalancesInput), outputSchema: standard(OpenBalancesOutput), annotations: read,
  }, (input) => safely(async () => result(getOpenBalances(await loadView(), input.person))));
  server.registerTool("list_payees", {
    title: "List payees", description: "Page counterparties appearing in this account by row count descending. Filter key/display name by substring. Totals include full bank amounts and transfers; seen_person associations are learned from settlements, not confirmed.",
    inputSchema: standard(PayeesInput), outputSchema: standard(PayeesOutput), annotations: read,
  }, (input) => safely(async () => result(pagePayees(await loadView(), input))));
  server.registerTool("find_payments", {
    title: "Find payment candidates", description: "Rank bank payments by amount (whole payment, participant share, or within ±2%), date distance, payee text and person evidence. When amount and person are supplied, a share match must belong to that person. Split summaries include split_rev for guarded writes. At least one of amount, text or person is required. One clear top candidate means use it and say which payment; several close candidates means ask the owner.",
    inputSchema: standard(FindPaymentsInput), outputSchema: standard(FindPaymentsOutput), annotations: read,
  }, (input) => safely(async () => result(findPayments(await loadView(), input))));
  server.registerTool("query", {
    title: "Query Money data", description: "Read-only SQLite over transactions, payees, people, splits, shares, settlements, net_events, owed, categories and standing_notes. Use describe_table for columns. Prefer purpose-built tools when they fit. Integer _paise money columns return exact rupee strings; refs work in all tools. One SELECT, max 100 rows; SQL runs only on an in-memory copy.",
    inputSchema: standard(QueryInput), outputSchema: standard(QueryOutput), annotations: read,
  }, (input) => safely(async () => {
    const sandbox = createQuerySandbox(async () => {
      const [view, categories, notes] = await Promise.all([loadView(), ops.listCategories(actor), ops.standingNotes(actor)]);
      return buildMcpQueryTables(view, categories, notes);
    });
    try {
      const outcome = await sandbox.run(input.sql);
      if (!outcome.ok) throw new McpToolError(outcome.error);
      return result(formatMcpQueryResult(outcome));
    } finally { sandbox.close(); }
  }));
  server.registerTool("describe_table", {
    title: "Describe a Money table", description: "Get the precise columns, units, scope and ref joins for one curated MCP query table. This model includes full unredacted data for this account and user-owned people/owed expenses; no database ids or secrets.",
    inputSchema: standard(DescribeTableInput), outputSchema: standard(DescribeTableOutput), annotations: read,
  }, (input) => safely(async () => result(describeMcpTable(input.name))));
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
    for (const name of Object.keys(RelationalInputs) as RelationalTool[]) {
      server.registerTool(name, {
        title: name.replaceAll("_", " "), description: RelationalDescriptions[name],
        inputSchema: standard(RelationalInputs[name]), outputSchema: standard(RelationalOutput),
        annotations: { readOnlyHint: false, destructiveHint: false },
      }, input => safely(async () => result(await requireWrites().relational(principal, name, input))));
    }
  }
  function requireWrites(): McpWriteOps {
    if (!writes) throw new McpToolError("Write operations aren't available.");
    return writes;
  }
  return server;
}
