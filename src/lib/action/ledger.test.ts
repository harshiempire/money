import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ForbiddenError } from "@/lib/auth/forbidden";
import { LedgerError, LedgerErrorCode } from "@/lib/ledger/context";
import { runAction } from "./core";
import { fromLedger, ledgerFailure } from "./ledger";
import { GENERIC_ERROR_MESSAGE } from "./result";
import { Schema } from "effect";

const expected: Record<string, string> = {
  invalid_input: "Invalid", invalid_row: "Invalid", invalid_cursor: "Invalid", invalid_amount: "Invalid",
  invalid_category: "Invalid", unknown_category: "Invalid", unknown_person: "Invalid", split_gap: "Invalid",
  over_allocation: "Invalid", invalid_source: "Invalid", duplicate_person: "Invalid", invalid_target: "Invalid",
  no_fields: "Invalid", no_payee: "Invalid",
  not_found: "NotFound",
  stale: "Conflict", idempotency_conflict: "Conflict", limit_reached: "Conflict", already_undone: "Conflict",
  existing_split: "Conflict", settled_split: "Conflict", net_event: "Conflict", explained_inflow: "Conflict",
  fully_allocated: "Conflict", no_open_shares: "Conflict",
  migration_required: "Unavailable", unavailable: "Unavailable",
};

describe("ledgerFailure", () => {
  test("every LedgerErrorCode is mapped, keeping the core's message", () => {
    expect(LedgerErrorCode.literals.length).toBe(Object.keys(expected).length);
    for (const code of LedgerErrorCode.literals) {
      const mapped = ledgerFailure(new LedgerError({ code, message: `msg for ${code}` }));
      expect(`${code}:${mapped._tag}`).toBe(`${code}:${expected[code]}`);
      expect(mapped.message).toBe(`msg for ${code}`);
    }
  });
});

const spec = (call: () => Promise<unknown>) => ({
  input: Schema.Struct({}),
  handler: () => fromLedger(call),
});
const run = (call: () => Promise<unknown>) =>
  runAction(spec(call), {}, { name: "t", layer: Layer.empty, log: () => {} });

describe("fromLedger through runAction", () => {
  test("a stale-card LedgerError reaches the client as CONFLICT with its text", async () => {
    const r = await run(async () => {
      throw new LedgerError({ code: "stale", message: "The category changed since this card was made. Ask again to get a fresh card." });
    });
    expect(r).toEqual({ ok: false, code: "CONFLICT", message: "The category changed since this card was made. Ask again to get a fresh card." });
  });

  test("migration_required is UNAVAILABLE", async () => {
    const r = await run(async () => {
      throw new LedgerError({ code: "migration_required", message: "Run migration 0014 before using the change log or MCP writes." });
    });
    expect(r).toMatchObject({ ok: false, code: "UNAVAILABLE" });
  });

  test("ForbiddenError from an ownership assert is FORBIDDEN", async () => {
    const r = await run(async () => {
      throw new ForbiddenError();
    });
    expect(r).toMatchObject({ ok: false, code: "FORBIDDEN", message: "You don't have access to that." });
  });

  test("any other error stays a defect: generic message, no internals", async () => {
    const r = await run(async () => {
      throw new Error("Failed query: insert into ... params: secret");
    });
    expect(r).toEqual({ ok: false, code: "INTERNAL", message: GENERIC_ERROR_MESSAGE });
  });

  test("success passes the core's result through", async () => {
    const r = await run(async () => ({ netEventId: "n1" }));
    expect(r).toEqual({ ok: true, data: { netEventId: "n1" } });
    void Effect;
  });
});
