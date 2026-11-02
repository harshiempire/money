import { expect, test } from "bun:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildMcpServer, principalFromContext, type McpOps } from "./server";
import type { McpPrincipal } from "./auth";
import { deriveMcpRefKey, deriveMcpRevKey, transactionRef } from "./refs";
import type { StoredTagRow } from "./proposal";
import { buildOverview } from "./overview";
import { resolveMcpPeriod } from "./range";
import type { PeriodInput } from "./schemas";
import { readFixture } from "./read-fixtures";
import { RelationalInputs } from "./relational-schemas";
import { LedgerError } from "@/lib/ledger/context";

const phase2Tools = ["get_transactions", "list_people", "get_open_balances", "list_payees", "find_payments", "query", "describe_table"];
const key = deriveMcpRefKey("protocol-test");
const principal: McpPrincipal = {
  actor: {
    userId: "alice",
    accountId: "acct",
  },
  scope: "read",
  tokenId: "tok",
  label: "Claude Code",
};
function fixture(
  categories = [
    {
      id: "cat-1",
      name: "Food",
      kind: "spend",
    },
  ],
  protocolVersion = "2025-11-25",
) {
  const drafts: Array<{ rows: StoredTagRow[] }> = [];
  const summaries: PeriodInput[] = [];
  const ops: McpOps = {
    readModel: async () => readFixture(),
    overview: async () => buildOverview([], [], []),
    listCategories: async () => categories,
    listTransactions: async () => [],
    periodSummary: async (_actor, input) => {
      summaries.push(input);
      return {
        period: resolveMcpPeriod(input), open_shares: "0.00",
        totals: { total_debit: "0.00", total_credit: "0.00", net_self: "0.00", owed_self: "0.00", count: 0 },
        bridge: { personal_debit_gross: "0.00", your_share_debit: "0.00", others_share: "0.00", net_credit: "0.00", split_txn_count: 0 },
        triage: { uncategorized_net_self: "0.00", uncategorized_count: 0, needs_review_count: 0 }, categories: [],
      };
    },
    standingNotes: async () => ["Pay ravi@bank 9876543210"],
    transactionIds: async () => ["db-1"],
    proposalTransactions: async () => [
      {
        id: "db-1",
        categoryId: null,
      },
    ],
    storeDraft: async (_p, draft) => {
      drafts.push(draft);
    },
  };
  const handler = createMcpHandler((ctx) => buildMcpServer(principalFromContext(ctx), ops, key, deriveMcpRevKey("protocol-test")), {
    legacy: "stateless",
    responseMode: "json",
    maxRequestBodySize: 256 * 1024,
  });
  const call = async (scope: "read" | "propose" | "write", method: string, params: unknown = {}) => {
    const modern = protocolVersion === "2026-07-28";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
    };
    if (modern) {
      headers["mcp-method"] = method;
      if (method === "tools/call" && typeof params === "object" && params !== null && "name" in params) {
        headers["mcp-name"] = String(params.name);
      }
    }
    const requestParams = modern
      ? {
          ...(params as Record<string, unknown>),
          _meta: {
            "io.modelcontextprotocol/protocolVersion": protocolVersion,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        }
      : params;
    const response = await handler.fetch(
      new Request("https://money.test/api/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: requestParams,
        }),
      }),
      {
        authInfo: {
          token: "authenticated",
          clientId: "tok",
          scopes: [scope],
          extra: {
            principal: {
              ...principal,
              scope,
            },
          },
        },
      },
    );
    const text = await response.text();

    const json =
      text.startsWith("event:") || text.startsWith("data:")
        ? JSON.parse(
            text
              .split("\n")
              .find((line) => line.startsWith("data: "))!
              .slice(6),
          )
        : JSON.parse(text);
    return {
      response,
      json,
    };
  };
  return {
    ops,
    drafts,
    summaries,
    handler,
    call,
  };
}

test("MCP preserves stable LedgerError codes and messages at the protocol boundary", async () => {
  const { call, handler, ops } = fixture();
  try {
    for (const code of ["invalid_input", "unavailable", "stale"] as const) {
      const message = code === "unavailable"
        ? "Database connection timed out while saving. Please try again in a moment."
        : "Amount must be positive";
      ops.listCategories = async () => { throw new LedgerError({ code, message }); };
      const result = await call("read", "tools/call", { name: "list_categories", arguments: {} });
      expect(result.json.result.isError).toBe(true);
      expect(result.json.result.content).toEqual([{ type: "text", text: `${code}: ${message}` }]);
    }
  } finally {
    await handler.close();
  }
});

for (const protocolVersion of ["2025-11-25", "2026-07-28"]) {
  test(`SDK ${protocolVersion} advertises scope-filtered tools and documented schemas`, async () => {
    const { call, handler } = fixture(undefined, protocolVersion);
    try {
      if (protocolVersion === "2025-11-25") {
        const init = await call("read", "initialize", {
          protocolVersion,
          capabilities: {},
          clientInfo: {
            name: "test",
            version: "1",
          },
        });
        expect(init.json.result.serverInfo.name).toBe("money");
      }
      for (const scope of ["read", "propose", "write"] as const) {
        const { json } = await call(scope, "tools/list");
        expect(json.result.tools.map((t: { name: string }) => t.name)).toEqual(
          scope === "read"
            ? ["get_overview", "list_categories", "list_transactions", "get_period_summary", "list_standing_notes", "suggest_categories", "review_period", ...phase2Tools]
            : [
                "get_overview",
                "list_categories",
                "list_transactions",
                "get_period_summary",
                "list_standing_notes",
                "suggest_categories", "review_period",
                ...phase2Tools,
                "propose_tags",
                ...(scope === "write" ? ["update_transactions", "set_payee_default", "list_changes", "undo_change", ...Object.keys(RelationalInputs)] : []),
              ],
        );
        const list = json.result.tools.find((t: { name: string }) => t.name === "list_transactions");
        for (const tool of json.result.tools) {
          expect(tool.title).toEqual(expect.any(String));
          expect(tool.description).toEqual(expect.any(String));
          expect(tool.description.length).toBeGreaterThan(20);
          if (phase2Tools.includes(tool.name)) {
            expect(tool.annotations.readOnlyHint).toBe(true);
            expect(tool.outputSchema.type).toBe("object");
            expect(tool.outputSchema.required.length).toBeGreaterThan(0);
          }
        }
        expect(list.inputSchema.properties.month).toMatchObject({
          type: "string",
          pattern: "^\\d{4}-(0[1-9]|1[0-2])$",
          description: expect.any(String),
        });
        if (scope === "write") {
          for (const name of Object.keys(RelationalInputs)) {
            const tool = json.result.tools.find((t: { name: string }) => t.name === name);
            expect(tool.annotations.readOnlyHint).toBe(false);
            expect(tool.description).toContain("Refuses");
            expect(tool.description).toContain("Undo");
            expect(tool.inputSchema.required).toContain("idempotency_key");
            expect(tool.inputSchema.properties.reason.maxLength).toBe(200);
            expect(tool.outputSchema.required).toContain("applied");
          }
          const update = json.result.tools.find((t: { name: string }) => t.name === "update_transactions");
          expect(update.inputSchema.properties.idempotency_key.pattern).toBe("^[A-Za-z0-9_-]{8,80}$");
          expect(update.inputSchema.properties.rows.minItems).toBe(1);
          expect(update.inputSchema.properties.rows.maxItems).toBe(100);
          expect(update.inputSchema.properties.rows.items.required).toEqual(["ref", "rev"]);
        }
        if (scope !== "read") {
          const proposal = json.result.tools.find((t: { name: string }) => t.name === "propose_tags");
          expect(proposal.inputSchema.properties.rows).toMatchObject({
            type: "array",
            minItems: 1,
            maxItems: 100,
            description: expect.any(String),
            items: {
              type: "object",
              required: ["ref", "category"],
              properties: {
                ref: {
                  type: "string",
                  description: expect.any(String),
                },
                category: {
                  type: "string",
                  description: expect.any(String),
                },
                confidence: {
                  enum: ["high", "medium", "low"],
                  description: expect.any(String),
                },
                reason: {
                  type: "string",
                  description: expect.any(String),
                },
              },
            },
          });
        }
        expect(list.inputSchema.properties.limit).toMatchObject({
          type: "integer",
          minimum: 1,
          maximum: 100,
        });
        expect(JSON.stringify(list.inputSchema)).not.toContain("Infinity");
        expect(list.inputSchema.required ?? []).toEqual([]);
      }
      for (const deniedScope of ["read", "propose"] as const) {
        for (const name of ["update_transactions", "set_payee_default", "list_changes", "undo_change", "link_person"]) {
          const deniedWrite = await call(deniedScope, "tools/call", { name, arguments: {} });
          expect(deniedWrite.json.error ?? deniedWrite.json.result?.isError).toBeTruthy();
        }
      }
      const denied = await call("read", "tools/call", {
        name: "propose_tags",
        arguments: { rows: [] },
      });
      expect(denied.json.error ?? denied.json.result?.isError).toBeTruthy();
    } finally {
      await handler.close();
    }
  });
  test(`SDK ${protocolVersion} rejects malformed rows individually and stores only accepted rows`, async () => {
    const { call, drafts, handler } = fixture(undefined, protocolVersion);
    try {
      const { json } = await call("propose", "tools/call", {
        name: "propose_tags",
        arguments: {
          rows: [
            {
              ref: transactionRef(key, "alice", "db-1"),
              category: "food",
            },
            {
              ref: 123,
              category: "Food",
            },
            {
              ref: "absent",
              category: "Food",
            },
          ],
        },
      });
      expect(json.result.isError).not.toBe(true);
      expect(json.result.structuredContent).toMatchObject({
        draft_stored: true,
        accepted: 1,
        rejected: [
          {
            index: 1,
            ref: null,
            code: "invalid_row",
          },
          {
            index: 2,
            ref: "absent",
            code: "unknown_ref",
          },
        ],
      });
      expect(drafts).toHaveLength(1);
      expect(drafts[0].rows).toEqual([
        {
          transactionId: "db-1",
          categoryId: "cat-1",
          expectedCurrentCategoryId: null,
          confidence: "medium",
          reason: null,
        },
      ]);
      await call("propose", "tools/call", {
        name: "propose_tags",
        arguments: { rows: [null, { ref: 123 }] },
      });
      expect(drafts).toHaveLength(1);
    } finally {
      await handler.close();
    }
  });
}
test("factory rejects absent or malformed principals", () => {
  expect(() => principalFromContext({ era: "legacy" })).toThrow();
  expect(() =>
    principalFromContext({
      era: "legacy",
      authInfo: {
        token: "placeholder",
        clientId: "tok",
        scopes: ["read"],
        extra: {
          principal: {
            ...principal,
            scope: "admin",
          },
        },
      },
    }),
  ).toThrow();
});

test("a full category name returned by list_categories round-trips without truncation", async () => {
  const name = "Food and dining ".repeat(12).trim();
  const { call, drafts, handler } = fixture([
    {
      id: "cat-1",
      name,
      kind: "spend",
    },
  ]);
  try {
    const listed = await call("propose", "tools/call", {
      name: "list_categories",
      arguments: {},
    });
    expect(listed.json.result.structuredContent.categories).toEqual([
      {
        name,
        kind: "spend",
      },
    ]);
    const proposed = await call("propose", "tools/call", {
      name: "propose_tags",
      arguments: {
        rows: [
          {
            ref: transactionRef(key, "alice", "db-1"),
            category: name,
          },
        ],
      },
    });
    expect(proposed.json.result.structuredContent.accepted).toBe(1);
    expect(drafts).toHaveLength(1);
  } finally {
    await handler.close();
  }
});

test("read scope exposes overview as read-only with its complete documented output", async () => {
  const { call, handler } = fixture();
  try {
    const listed = await call("read", "tools/list");
    const tool = listed.json.result.tools.find((t: { name: string }) => t.name === "get_overview");
    expect(tool.description).toStartWith("Call this first");
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.inputSchema.properties ?? {}).toEqual({});
    expect(tool.outputSchema.required).toEqual(["first_transaction_date", "last_transaction_date", "months", "totals", "people"]);
    expect(Object.keys(tool.outputSchema.properties.months.items.properties)).toEqual([
      "month", "rows", "paid", "received", "uncategorized", "split_count", "open_shares",
    ]);
    const overview = await call("read", "tools/call", { name: "get_overview", arguments: {} });
    expect(overview.json.result.structuredContent).toEqual(buildOverview([], [], []));
  } finally { await handler.close(); }
});

test("self-contained instructions include shared guidance and write guidance only for write scope", async () => {
  const { call, handler } = fixture();
  try {
    for (const scope of ["read", "propose", "write"] as const) {
      const init = await call(scope, "initialize", {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
      });
      const brief = init.json.result.instructions;
      expect(brief).toStartWith("Start with get_overview.");
      for (const text of ["Never assume a month", "across months or all time", "exact rupee strings", "money math in your head",
        "several UPI handles", "Never bypass the MCP", "DB scripts", "app internals", ".env files", "tool is missing", "propose_tags stays draft-only", "Prefer get_open_balances, find_payments, get_transactions and list_people", "use query"])
        expect(brief).toContain(text);
      if (scope === "write") {
        for (const text of ["read current refs and revs", "fresh idempotency key per request", "identical retry", "report what changed", "change id", "undo_change", "Connections"])
          expect(brief).toContain(text);
      } else {
        expect(brief).not.toContain("Before writing");
        expect(brief).not.toContain("idempotency");
      }
    }
  } finally { await handler.close(); }
});

test("summary forwards all-time/range input and both read tools reject mixed ranges before calling ops", async () => {
  const { call, handler, summaries } = fixture();
  try {
    for (const input of [{}, { month: "2026-10" }, { from: "2026-01-01", to: "2026-10-31" }]) {
      const read = await call("read", "tools/call", { name: "get_period_summary", arguments: input });
      expect(read.json.result.isError).not.toBe(true);
      expect(read.json.result.structuredContent.period).toEqual(resolveMcpPeriod(input));
    }
    expect(summaries).toEqual([{}, { month: "2026-10" }, { from: "2026-01-01", to: "2026-10-31" }]);
    for (const name of ["list_transactions", "get_period_summary"]) {
      const bad = await call("read", "tools/call", { name, arguments: { month: "2026-10", from: "2026-10-01" } });
      expect(bad.json.error ?? bad.json.result?.isError).toBeTruthy();
    }
    expect(summaries).toHaveLength(3);
  } finally { await handler.close(); }
});

test("standing notes and categories are returned unfiltered without database ids or an omitted count", async () => {
  const name = "  Food@home 123456 ";
  const { call, handler } = fixture([{ id: "private-category-id", name, kind: "spend" }]);
  try {
    const categories = await call("read", "tools/call", { name: "list_categories", arguments: {} });
    expect(categories.json.result.structuredContent).toEqual({ categories: [{ name, kind: "spend" }] });
    const notes = await call("read", "tools/call", { name: "list_standing_notes", arguments: {} });
    expect(notes.json.result.structuredContent).toEqual({ notes: ["Pay ravi@bank 9876543210"] });
  } finally { await handler.close(); }
});

for (const scope of ["read", "propose", "write"] as const) {
  test(`phase 2 tools execute through the SDK with structured output for ${scope}`, async () => {
    const { call, handler } = fixture();
    try {
      const args: Record<string, object> = {
        get_transactions: { refs: ["unknown", transactionRef(key, "alice", "private-bill")] },
        list_people: {}, get_open_balances: { person: "kIrAn" }, list_payees: { limit: 1 },
        find_payments: { amount: "274", person: "Kiran" }, describe_table: { name: "shares" },
        query: { sql: "select ref, amount_paise, note from transactions order by date limit 1" },
      };
      for (const name of phase2Tools) {
        const { json } = await call(scope, "tools/call", { name, arguments: args[name] });
        expect(json.error).toBeUndefined();
        expect(json.result.isError).not.toBe(true);
        expect(json.result.structuredContent).toBeTruthy();
        expect(JSON.stringify(json.result.structuredContent)).not.toContain("private-");
        if (name === "get_transactions") {
          expect(json.result.structuredContent.unknown_refs).toEqual(["unknown"]);
          expect(json.result.structuredContent.transactions[0].split.shares[0].left).toBe("194.00");
        }
        if (name === "find_payments") expect(json.result.structuredContent.candidates[0].amount).toBe("567.00");
        if (name === "query") expect(json.result.structuredContent.rows[0][1]).toBe("12.00");
      }
      const invalid = await call(scope, "tools/call", { name: "find_payments", arguments: { date: "2026-07-31" } });
      expect(invalid.json.error ?? invalid.json.result?.isError).toBeTruthy();
      const unknown = await call(scope, "tools/call", { name: "get_open_balances", arguments: { person: "Ravi" } });
      expect(unknown.json.result.isError).toBe(true); expect(unknown.json.result.content[0].text).toContain("Ravi Teja");
      const refused = await call(scope, "tools/call", { name: "query", arguments: { sql: "select * from sqlite_schema" } });
      expect(refused.json.result.isError).toBe(true);
    } finally { await handler.close(); }
  });
}

for (const scope of ["read", "propose", "write"] as const) {
  test(`phase 5 read tools execute and reject mixed periods for ${scope}`, async () => {
    const { handler, call } = fixture();
    try {
      for (const name of ["suggest_categories", "review_period"]) {
        const { json } = await call(scope, "tools/call", { name, arguments: { month: "2026-08" } });
        expect(json.result.isError).not.toBe(true);
        const data = json.result.structuredContent;
        if (name === "suggest_categories") {
          expect(data.rows.length).toBeGreaterThan(0);
          expect(data.unsure_groups.length).toBeGreaterThan(0);
        } else {
          expect(data.uncategorized.count).toBeGreaterThan(0);
          expect(data.unlinked_inflows.rows[0].via).toBe("seen");
        }
        const bad = await call(scope, "tools/call", { name, arguments: { month: "2026-08", from: "2026-08-01" } });
        expect(bad.json.error ?? bad.json.result?.isError).toBeTruthy();
      }
    } finally { await handler.close(); }
  });
}
