import { expect, test } from "bun:test";

test("revoking an owned token preserves an existing revocation and succeeds on retries", async () => {
  // Isolate the DB mock from Bun's shared module cache; this process opens no database connection.
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-env-file",
      "-e",
      `
      import { mock } from "bun:test";
      import assert from "node:assert/strict";
      import { drizzle } from "drizzle-orm/postgres-js";
      import * as schema from "./src/db/schema";

      let owned = true;
      let revokedAt = null;
      const queries = [];
      const client = {
        options: { parsers: {}, serializers: {} },
        unsafe(query, params) {
          queries.push({ query, params });
          return {
            values: async () => {
              if (query.startsWith("update")) {
                if (!owned || (query.includes('"revoked_at" is null') && revokedAt !== null)) return [];
                revokedAt = params[0];
                return [["token-id"]];
              }
              return owned ? [["token-id"]] : [];
            },
          };
        },
      };
      const db = drizzle(client, { schema });
      mock.module("server-only", () => ({}));
      mock.module("@/db", () => ({ db, schema }));
      const { revokeToken } = await import("./src/lib/mcp/token-store");
      const actor = { userId: "owner", accountId: "account" };

      assert.deepEqual(await revokeToken(actor, "token-id"), { ok: true });
      assert.notEqual(revokedAt, null);
      const firstRevokedAt = "2000-01-01T00:00:00.000Z";
      revokedAt = firstRevokedAt;
      assert.deepEqual(await revokeToken(actor, "token-id"), { ok: true });
      assert.equal(revokedAt, firstRevokedAt);
      owned = false;
      assert.deepEqual(await revokeToken(actor, "token-id"), {
        ok: false,
        error: "That token isn't available.",
      });
      for (const { query, params } of queries) {
        assert.ok(query.includes('"user_id" ='));
        assert.ok(query.includes('"account_id" ='));
        assert.ok(params.includes("owner"));
        assert.ok(params.includes("account"));
        assert.ok(params.includes("token-id"));
      }
    `,
    ],
    cwd: process.cwd(),
    env: {},
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({
    exitCode,
    stderr,
  }).toEqual({
    exitCode: 0,
    stderr: "",
  });
});
