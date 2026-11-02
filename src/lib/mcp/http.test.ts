import { expect, test } from "bun:test";
import { handleMcpHttp } from "./http";
import { McpInvalidToken, McpMissingToken, McpNotConfigured, McpRateLimited } from "./auth";

test("cross-host origins are rejected before authentication", async () => {
  let calls = 0;
  const response = await handleMcpHttp(
    new Request("https://money.test/api/mcp", { headers: { origin: "https://evil.test" } }),
    {
      authenticate: async () => {
        calls++;
        throw new Error();
      },
      fetch: async () => new Response(),
    },
  );
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(calls).toBe(0);
});
test("auth failures yield bearer challenges, retry headers and no-store", async () => {
  for (const [error, status] of [
    [new McpMissingToken(), 401],
    [new McpInvalidToken(), 401],
    [new McpRateLimited({ retryAfterSeconds: 42 }), 429],
    [new McpNotConfigured(), 503],
  ] as const) {
    const response = await handleMcpHttp(
      new Request("https://money.test/api/mcp", { headers: { authorization: "Bearer secret" } }),
      {
        authenticate: async () => {
          throw error;
        },
        fetch: async () => {
          throw new Error("must not run");
        },
      },
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    if (status === 401)
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="money", error="invalid_token"');
    if (status === 429) expect(response.headers.get("retry-after")).toBe("42");
    expect(await response.text()).not.toContain("secret");
  }
});
test("GET POST and DELETE pass the principal with a non-secret authInfo token", async () => {
  for (const method of ["GET", "POST", "DELETE"]) {
    const principal = {
      actor: {
        userId: "u",
        accountId: "a",
      },
      scope: "read" as const,
      tokenId: "t",
      label: "bot",
    };
    const response = await handleMcpHttp(
      new Request("https://money.test/api/mcp", {
        method,
        headers: {
          origin: "https://money.test",
          authorization: "Bearer secret",
        },
      }),
      {
        authenticate: async () => principal,
        fetch: async (_request, options) => {
          expect(options?.authInfo).toEqual({
            token: "money-authenticated",
            clientId: "t",
            scopes: ["read"],
            extra: { principal },
          });
          return new Response("ok");
        },
      },
    );
    expect(response.status).toBe(200);
  }
});
