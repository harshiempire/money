import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildMcpServer, principalFromContext, type McpOps } from "../mcp/server";
import { deriveMcpRefKey, deriveMcpRevKey } from "../mcp/refs";
import { isUseServerFile } from "../../../scripts/lib/server-action-exports";
import { CAPABILITIES, NON_FINANCIAL_ACTIONS, NON_FINANCIAL_TOOLS, refreshPaths } from "./capabilities";

// Listing tools never invokes operations. Unexpected execution must fail loudly.
const unused = async (): Promise<never> => { throw new Error("tool listing executed an operation"); };
const ops: McpOps = {
  readModel: unused, overview: unused, listCategories: unused, listTransactions: unused,
  periodSummary: unused, standingNotes: unused, transactionIds: unused,
  proposalTransactions: unused, storeDraft: unused,
};
const tools = CAPABILITIES.flatMap(c => "tools" in c.mcp ? c.mcp.tools : []);
const rank = { read: 0, propose: 1, write: 2 };
for (const scope of ["read", "propose", "write"] as const) {
  test(`runtime tool inventory matches ${scope} scope`, async () => {
    const handler = createMcpHandler(ctx => buildMcpServer(
      principalFromContext(ctx), ops, deriveMcpRefKey("capability-test"), deriveMcpRevKey("capability-test"),
    ), { legacy: "stateless", responseMode: "json" });
    const response = await handler.fetch(new Request("https://money.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }), { authInfo: {
      token: "test", clientId: "test-token", scopes: [scope],
      extra: { principal: { actor: { userId: "test-user", accountId: "test-account" }, scope, tokenId: "test-token", label: "Test" } },
    } });
    if (!response.ok) throw new Error(await response.text());
    const text = await response.text();
    const payload = text.startsWith("event:") || text.startsWith("data:")
      ? text.split("\n").find(line => line.startsWith("data: "))!.slice(6)
      : text;
    const body = JSON.parse(payload) as { result: { tools: { name: string }[] } };
    const actual = body.result.tools.map(t => t.name).sort();
    const expected = [...tools.filter(t => rank[t.scope] <= rank[scope]).map(t => t.name), ...Object.keys(NON_FINANCIAL_TOOLS)].sort();
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });
}

test("Bun's complete value-export scanner agrees with the action register", () => {
  const actual = readdirSync("src/app", { recursive: true, encoding: "utf8" })
    .filter(p => /\.tsx?$/.test(p))
    .flatMap(p => {
      const source = readFileSync(`src/app/${p}`, "utf8");
      return isUseServerFile(source) ? new Bun.Transpiler({ loader: "tsx" }).scan(source).exports : [];
    }).sort();
  const registered = [...CAPABILITIES.flatMap(c => "actions" in c.app ? c.app.actions : []), ...Object.keys(NON_FINANCIAL_ACTIONS)].sort();
  expect(actual).toEqual(registered);
});

test("refresh unions preserve existing app and MCP paths", () => {
  const cases: [string, string[]][] = [
    ["transaction.fields", ["/transactions", "/review", "/", "/timeline", "/connections"]],
    ["split.create", ["/transactions", "/reimbursements", "/people", "/spend", "/", "/connections"]],
    ["settlement.cash.record", ["/transactions", "/reimbursements", "/people", "/spend", "/", "/connections"]],
    ["owed.update", ["/transactions", "/reimbursements", "/people", "/spend", "/", "/connections"]],
    ["change.undo", ["/transactions", "/reimbursements", "/people", "/spend", "/", "/connections"]],
    ["statement.import", ["/import", "/transactions"]],
  ];
  for (const [id, paths] of cases) {
    expect(refreshPaths(id)).toEqual(expect.arrayContaining(paths));
    expect(new Set(refreshPaths(id)).size).toBe(refreshPaths(id).length);
  }
  expect(() => refreshPaths("missing")).toThrow("Unknown capability");
});
