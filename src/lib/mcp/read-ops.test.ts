import { expect, test } from "bun:test";

test("read adapter renders full rows and scopes overview/open-share SQL to the actor without a database", async () => {
  // Run a fake driver in isolation so module mocks cannot leak into other tests.
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", "-e", `
      import { mock } from "bun:test";
      import assert from "node:assert/strict";
      import { drizzle } from "drizzle-orm/postgres-js";
      import * as schema from "./src/db/schema";
      const queries = [];
      const client = {
        options: { parsers: {}, serializers: {} },
        unsafe(query, params) {
          queries.push({ query, params });
          return { values: async () => {
            if (query.includes('from "person"')) return [["person", "Ravi"]];
            if (query.includes('from "split_participant"')) return [["share", "person", "Ravi", "2026-10-31", "Meal", 101, "bill", "2026-01-01T00:00:00Z", "Meal", null, null, null]];
            if (query.includes('from "owed_expense"')) return [["owed", "person", "Ravi", "2026-10-31", "Meal", 55, null]];
            if (query.includes('from "settlement"') || query.includes('from "counterparty"')) return [];
            if (query.includes('exists (select 1')) return [["2026-10-31", 56700, "debit", null, true]];
            return [["private-id", "2026-10-31", 56700, "debit", "upi", "ravi@bank", "upi_handle", "ravi@bank", "Petr", "UPI 12345678 ravi@bank", "phone 9876543210", null, "Food@home", false, false, null]];
          } };
        },
      };
      const db = drizzle(client, { schema });
      mock.module("server-only", () => ({}));
      mock.module("@/db", () => ({ db, schema }));
      mock.module("@/lib/assistant/actor-ops", () => ({ readStandingNotes: async () => [] }));
      mock.module("@/lib/assistant/data", () => ({ loadCategories: async () => [] }));
      const { mcpReadOps } = await import("./src/lib/mcp/read-ops");
      const actor = { userId: "owner", accountId: "owned-account" };
      const overview = await mcpReadOps.overview(actor);
      assert.deepEqual(overview.totals, { rows: 1, paid: "567.00", received: "0.00", uncategorized: 1, split_count: 1, open_shares: "1.01" });
      assert.deepEqual(overview.people, [{ name: "Ravi", owed_to_you: "1.01", you_owe: "0.55" }]);
      assert.equal(queries.length, 7);
      for (const { query, params } of queries) {
        assert.ok(params.includes("owner"));
        if (query.includes('inner join "money_account"')) {
          assert.ok(query.includes('"money_account"."user_id" ='));
          assert.ok(params.includes("owned-account"));
        }
      }
      const share = queries.find(q => q.query.includes('from "split_participant"')).query;
      assert.ok(share.includes('inner join "split"'));
      assert.ok(share.includes('inner join "transaction"'));
      const owed = queries.find(q => q.query.includes('from "owed_expense"')).query;
      assert.ok(owed.includes('"owed_expense"."user_id" ='));
      const settlements = queries.filter(q => q.query.includes('from "settlement"'));
      assert.equal(settlements.length,2);
      assert.ok(settlements.some(q => q.query.includes('"settlement"."split_participant_id" = "split_participant"."id"')));
      assert.ok(settlements.some(q => q.query.includes('"settlement"."owed_expense_id" = "owed_expense"."id"')));
      queries.length = 0;
      const rows = await mcpReadOps.listTransactions(actor, { from: "2026-10-01", to: "2026-10-31", direction: "paid", uncategorized: true });
      assert.equal(rows[0].displayName, "ravi@bank");
      assert.equal(rows[0].counterpartyKey, "ravi@bank");
      assert.equal(rows[0].rawDescription, "UPI 12345678 ravi@bank");
      assert.equal(rows[0].note, "phone 9876543210");
      assert.equal(rows[0].defaultCategory, "Food@home");
      const filtered = queries[0];
      for (const value of ["owner", "owned-account", "2026-10-01", "2026-10-31", "debit"]) assert.ok(filtered.params.includes(value));
      assert.ok(filtered.query.includes('"transaction"."category_id" is null'));
      assert.ok(filtered.query.includes('"transaction"."txn_date" >='));
      assert.ok(filtered.query.includes('"transaction"."txn_date" <='));
    `],
    cwd: process.cwd(), env: {}, stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
});
