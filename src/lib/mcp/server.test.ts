import { expect, test } from "bun:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildMcpServer, principalFromContext, type McpOps } from "./server";
import type { McpPrincipal } from "./auth";
import { deriveMcpRefKey, transactionRef } from "./refs";
import type { StoredTagRow } from "./proposal";

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
  const ops: McpOps = {
    listCategories: async () => categories,
    listTransactions: async () => [],
    periodSummary: async () => {
      throw new Error("Unused");
    },
    standingNotes: async () => [],
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
  const handler = createMcpHandler((ctx) => buildMcpServer(principalFromContext(ctx), ops, key), {
    legacy: "stateless",
    responseMode: "json",
    maxRequestBodySize: 256 * 1024,
  });
  const call = async (scope: "read" | "propose", method: string, params: unknown = {}) => {
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
    drafts,
    handler,
    call,
  };
}
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
      for (const scope of ["read", "propose"] as const) {
        const { json } = await call(scope, "tools/list");
        expect(json.result.tools.map((t: { name: string }) => t.name)).toEqual(
          scope === "read"
            ? ["list_categories", "list_transactions", "get_period_summary", "list_standing_notes"]
            : [
                "list_categories",
                "list_transactions",
                "get_period_summary",
                "list_standing_notes",
                "propose_tags",
              ],
        );
        const list = json.result.tools.find((t: { name: string }) => t.name === "list_transactions");
        for (const tool of json.result.tools) {
          expect(tool.title).toEqual(expect.any(String));
          expect(tool.description).toEqual(expect.any(String));
          expect(tool.description.length).toBeGreaterThan(20);
        }
        expect(list.inputSchema.properties.month).toMatchObject({
          type: "string",
          pattern: "^\\d{4}-(0[1-9]|1[0-2])$",
          description: expect.any(String),
        });
        if (scope === "propose") {
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

test("a safe category name returned by list_categories round-trips without truncation", async () => {
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
