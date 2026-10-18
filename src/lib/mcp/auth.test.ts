import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { authenticateMcpRequestCore, type McpAuthDeps, type TokenLookup } from "./auth";
import { generateMcpToken, hashMcpToken } from "./token";

const token = "mny_" + "A".repeat(43);
const record: TokenLookup = {
  id: "token-id",
  userId: "owner",
  accountId: "account",
  accountUserId: "owner",
  name: "Claude",
  scope: "read",
  userTokenVersion: 2,
  currentTokenVersion: 2,
  revokedAt: null,
  lastUsedAt: null,
};
function setup(overrides: Partial<McpAuthDeps> = {}) {
  const touched: string[] = [];
  const deps: McpAuthDeps = {
    configured: true,
    lookup: async () => record,
    rateLimit: async () => ({ ok: true }),
    now: () => new Date("2026-10-18T10:00:00Z"),
    touch: async (id) => {
      touched.push(id);
    },
    ...overrides,
  };
  const run = (header?: string) =>
    Effect.runPromise(
      Effect.result(
        authenticateMcpRequestCore(
          new Request("https://money.test/api/mcp", { headers: header ? { authorization: header } : {} }),
          deps,
        ),
      ),
    );
  return {
    run,
    touched,
  };
}
test("tokens use 32 random bytes and hash the full plaintext with SHA-256", () => {
  const a = generateMcpToken();
  expect(a).toMatch(/^mny_[A-Za-z0-9_-]{43}$/);
  expect(generateMcpToken()).not.toBe(a);
  expect(hashMcpToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
test("no authorization is missing; malformed authorization is invalid", async () => {
  const { run } = setup();
  const missing = await run();
  expect(Result.isFailure(missing) && missing.failure._tag).toBe("McpMissingToken");
  for (const header of [
    "Basic abc",
    "Bearer abc",
    "Bearer bad_" + "A".repeat(43),
    "Bearer " + token + " extra",
  ]) {
    const result = await run(header);
    expect(Result.isFailure(result) && result.failure._tag).toBe("McpInvalidToken");
  }
});
test("unknown, revoked, invalidated, or foreign-account tokens fail closed", async () => {
  for (const row of [
    null,
    {
      ...record,
      revokedAt: new Date(),
    },
    {
      ...record,
      currentTokenVersion: 3,
    },
    {
      ...record,
      accountUserId: "someone-else",
    },
  ]) {
    const { run, touched } = setup({ lookup: async () => row });
    const result = await run(`Bearer ${token}`);
    expect(Result.isFailure(result) && result.failure._tag).toBe("McpInvalidToken");
    expect(touched).toEqual([]);
  }
});
test("valid scopes return one actor and touch at most once per minute", async () => {
  for (const scope of ["read", "propose"] as const) {
    const { run, touched } = setup({
      lookup: async () => ({
        ...record,
        scope,
      }),
    });
    const result = await run(`bEaReR ${token}`);
    expect(Result.isSuccess(result) && result.success).toEqual({
      actor: {
        userId: "owner",
        accountId: "account",
      },
      scope,
      tokenId: "token-id",
      label: "Claude",
    });
    expect(touched).toEqual(["token-id"]);
  }
  const { run, touched } = setup({
    lookup: async () => ({
      ...record,
      lastUsedAt: new Date("2026-10-18T09:59:30Z"),
    }),
  });
  await run(`Bearer ${token}`);
  expect(touched).toEqual([]);
});
test("rate limits retain retry seconds and missing configuration fails closed", async () => {
  const limited = await setup({
    rateLimit: async () => ({
      ok: false,
      retryAfterSeconds: 42,
    }),
  }).run(`Bearer ${token}`);
  expect(Result.isFailure(limited) && limited.failure).toMatchObject({
    _tag: "McpRateLimited",
    retryAfterSeconds: 42,
  });
  const unconfigured = await setup({ configured: false }).run(`Bearer ${token}`);
  expect(Result.isFailure(unconfigured) && unconfigured.failure._tag).toBe("McpNotConfigured");
});
test("last-used tracking failure does not reject valid authentication", async () => {
  const { run } = setup({
    touch: async () => {
      throw new Error("Tracking unavailable");
    },
  });
  const result = await run(`Bearer ${token}`);
  expect(Result.isSuccess(result) && result.success).toEqual({
    actor: {
      userId: "owner",
      accountId: "account",
    },
    scope: "read",
    tokenId: "token-id",
    label: "Claude",
  });
});

test("authentication looks up the SHA-256 hex of the entire bearer token", async () => {
  const { run } = setup({
    lookup: async (hash) => {
      expect(hash).toBe("14702d3329143dbce26de13df027313c63a5134ac5926548bd669a22901d152a");
      return record;
    },
  });
  expect(Result.isSuccess(await run(`Bearer ${token}`))).toBe(true);
});
