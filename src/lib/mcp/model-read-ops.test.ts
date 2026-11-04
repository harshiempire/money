import { expect, test } from "bun:test";

test("full-model loader scopes every SQL branch and finds inflow links without querying a database", async () => {
  // An isolated fake Postgres driver renders actual Drizzle SQL and cannot open a socket.
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
          return { values: async () => [] };
        },
      };
      const db = drizzle(client, { schema });
      mock.module("server-only", () => ({}));
      mock.module("@/db", () => ({ db, schema }));
      const { loadMcpReadModel } = await import("./src/lib/mcp/model-read-ops");
      const actor = { userId: "owner-scope", accountId: "account-scope" };
      let loaded = 0;
      const model = await loadMcpReadModel(actor, async () => { loaded++; return []; });
      assert.equal(loaded, 1); assert.equal(queries.length, 15);
      assert.deepEqual(model.settlements, []); assert.deepEqual(model.linkedInflows, []);
      for (const { query, params } of queries) {
        assert.ok(params.includes("owner-scope"), query);
        if (query.includes('inner join "money_account"')) {
          assert.ok(params.includes("account-scope"), query);
          assert.ok(query.includes('"money_account"."user_id" ='), query);
          assert.ok(query.includes('"money_account"."id" ='), query);
        } else {
          assert.ok(query.includes('"person"."user_id" =') || query.includes('"owed_expense"."user_id" =') || query.includes('"net_event"."user_id" ='), query);
        }
      }
      const shareSettlement = queries.find(q => q.query.includes('from "settlement" inner join "split_participant"') && q.query.includes("at time zone 'UTC'")).query;
      assert.ok(shareSettlement.includes('inner join "split"'));
      assert.ok(shareSettlement.includes('inner join "transaction"'));
      assert.ok(shareSettlement.includes('inner join "money_account"'));
      assert.ok(shareSettlement.includes("at time zone 'UTC'"));
      const owedSettlement = queries.find(q => q.query.includes('from "settlement" inner join "owed_expense"')).query;
      assert.ok(owedSettlement.includes('"owed_expense"."user_id" ='));
      const payees = queries.find(q => q.query.includes('from "counterparty"') && q.query.includes('mcp_default_category')).query;
      assert.ok(payees.includes('"counterparty"."user_id" ='));
      assert.ok(payees.includes('"mcp_default_category"."user_id" ='));
      assert.ok(payees.includes('"transaction"."account_id" = "money_account"."id"'));
      const inflows = queries.find(q => q.query.includes('from "transaction" inner join "money_account"')).query;
      for (const column of ['"settlement"."inflow_transaction_id"', '"net_event"."inflow_transaction_id"', '"net_event"."outflow_transaction_id"', '"owed_expense"."source_inflow_transaction_id"', '"transaction"."residual_disposition"', '"transaction"."residual_acknowledged_paise"']) assert.ok(inflows.includes(column), inflows);
      assert.ok(inflows.includes('"transaction"."dr_cr" ='));
    `], cwd: process.cwd(), env: {}, stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
});
