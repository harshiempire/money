/**
 * The agent loop with a stand-in model: each test scripts what "ChatGPT"
 * answers at every step, and checks what the loop does with it. Data comes
 * from fixtures; the query sandbox is the real one (it runs Node).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realResponses from "@/lib/ai/chatgpt/responses";
import type { AgentStepResult, ResponseItem } from "@/lib/ai/chatgpt/responses";
import * as realSandbox from "./query-sandbox";
import type { QueryData } from "./query-tables";
import type { TxnCardData } from "./types";

type Step = (input: ResponseItem[]) => AgentStepResult;
const LIMITS = { usedPercent: null, resetsAt: null, windowMinutes: null };
let script: Step[] = [];
let modelCalls = 0;

const card = (id: string, txnDate: string, amountPaise: number, label: string): TxnCardData => ({
  id, txnDate, amountPaise, drCr: "debit", channel: "upi", label, purpose: null, note: null,
  categoryId: null, needsReview: false, split: null, netEventId: null, href: `/transactions?txn=${id}`,
});
const CARDS = [card("id-etsi", "2026-08-06", 224700, "Etsi"), card("id-swiggy", "2026-08-07", 50000, "Swiggy")];
const QUERY_DATA: QueryData = {
  txns: CARDS.map((c) => ({
    id: c.id, date: c.txnDate, paise: c.amountPaise, direction: "paid" as const, payee: c.label,
    note: null, category: "Food", channel: "upi", isTransfer: false, netSettled: false,
  })),
  categories: [{ name: "Food", kind: "spend" }],
  people: ["Nitin"],
  splits: [],
  participants: [],
  owed: [],
};

// Bun shares mocked modules with every test file, so mocks keep the real
// exports (snapshotted first) and replace only what the loop calls out to.
const responsesExports = { ...realResponses };
const sandboxExports = { ...realSandbox };

mock.module("server-only", () => ({}));
mock.module("@/lib/ai/chatgpt/token-store", () => ({
  getChatgptAccess: async () => ({ ok: true, accessToken: "token", accountId: "acct" }),
}));
mock.module("@/lib/ai/chatgpt/responses", () => ({
  ...responsesExports,
  callAgentStep: async (input: { input: ResponseItem[] }) => {
    modelCalls++;
    const next = script.shift();
    if (!next) throw new Error(`the model was called more often than scripted (call ${modelCalls})`);
    return next(input.input);
  },
}));
mock.module("@/lib/transactions/search", () => ({
  yearsWithData: async () => [2026],
  findTransactionCandidates: async (q: { amountPaise: number | null }) =>
    CARDS.filter((c) => q.amountPaise === null || c.amountPaise === q.amountPaise).map((c) => ({
      id: c.id, txnDate: c.txnDate, amountPaise: c.amountPaise, drCr: c.drCr, label: c.label,
      counterpartyDisplayName: null, channel: c.channel, rawDescription: c.label, parsedPurpose: null, note: null,
    })),
}));
mock.module("./data", () => ({
  loadTxnCards: async (_a: string, _u: string, ids: string[]) => CARDS.filter((c) => ids.includes(c.id)),
  loadOpenLinesForPerson: async () => ({ recv: [], pay: [] }),
  loadQueryData: async () => QUERY_DATA,
}));
// The real sandbox, counting how many are left open.
const realCreate = sandboxExports.createQuerySandbox;
let openSandboxes = 0;
mock.module("./query-sandbox", () => ({
  ...sandboxExports,
  createQuerySandbox: (...args: Parameters<typeof realCreate>) => {
    const s = realCreate(...args);
    openSandboxes++;
    return { run: s.run, close: () => (openSandboxes--, s.close()) };
  },
}));

const { runAgentTurn } = await import("./agent");

let callNo = 0;
const call = (name: string, args: object): Step => () => {
  const callId = `call_${++callNo}`;
  const argText = JSON.stringify(args);
  return {
    ok: true,
    items: [{ type: "function_call", call_id: callId, name, arguments: argText }],
    text: "",
    calls: [{ callId, name, arguments: argText }],
    limits: LIMITS,
  };
};
const say = (text: string): Step => () => ({
  ok: true,
  items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  text,
  calls: [],
  limits: LIMITS,
});
/** What the last tool call returned to the model. */
const lastOutput = (input: ResponseItem[]) => JSON.parse(String(input.at(-1)?.output));

const turn = (message: string, focusTxnId: string | null = null) =>
  runAgentTurn({
    userId: "user", accountId: "account", today: "2026-10-06", message, history: [], focusTxnId,
    resumedAfterPick: false, categories: [{ id: "cat-food", name: "Food", kind: "spend" }], knownPeople: ["Nitin"],
  });

beforeEach(() => {
  script = [];
  modelCalls = 0;
});

describe("agent loop", () => {
  test("answers a question with a query, in exact rupees, and closes the sandbox", async () => {
    let seen: { rows?: unknown[][] } = {};
    script = [
      call("query", { sql: "select sum(paise) as spent_paise from txn where direction = 'paid' and is_transfer = 0" }),
      (input) => {
        seen = lastOutput(input);
        return say("You spent ₹2,747 on food.")(input);
      },
    ];
    const out = await turn("how much did I spend in August?");
    expect(seen.rows).toEqual([["₹2,747.00"]]);
    expect(out.messages[0]).toMatchObject({ kind: "ai", text: "You spent ₹2,747 on food." });
    expect(out.messages[0].kind === "ai" && out.messages[0].trace?.[0]).toMatch(/^query: select sum\(paise\).* → 1 row$/);
    expect(out.txnIds).toEqual([]);
    expect(openSandboxes).toBe(0);
  });

  test("a failed query goes back to the model, which fixes it", async () => {
    let error = "";
    script = [
      call("query", { sql: "select * from users" }),
      (input) => {
        error = lastOutput(input).error;
        return call("query", { sql: "select count(*) from txn" })(input);
      },
      say("You have 2 transactions."),
    ];
    const out = await turn("how many transactions do I have?");
    expect(error).toContain("no such table");
    expect(out.messages[0]).toMatchObject({ text: "You have 2 transactions." });
  });

  test("a ref found by a query can be shown but not changed", async () => {
    let refused = "";
    script = [
      call("query", { sql: "select ref from txn where payee = 'Etsi'" }),
      (input) => {
        const ref = lastOutput(input).rows[0][0];
        return call("propose_note", { txn_ref: ref, note_text: "dinner" })(input);
      },
      (input) => {
        refused = lastOutput(input).error;
        return call("show_transactions", { refs: ["T1"] })(input);
      },
      say("Here it is. Tell me if you want the note on it."),
    ];
    const out = await turn("add a note dinner to my Etsi payment");
    expect(refused).toContain("came from a query");
    expect(out.messages.some((m) => m.kind === "op")).toBe(false);
    expect(out.messages).toContainEqual({ kind: "txn", txnId: "id-etsi" });
    // The card the user now sees becomes CURRENT for their next message.
    expect(out.focusTxnId).toBe("id-etsi");
  });

  test("showing several transactions lists them for the user to pick", async () => {
    script = [call("query", { sql: "select ref from txn order by date" }), call("show_transactions", { refs: ["T1", "T2"] }), say("Here they are.")];
    const out = await turn("show my food payments");
    expect(out.messages).toContainEqual({ kind: "pick", txnIds: ["id-etsi", "id-swiggy"], total: 2, then: "show" });
  });

  test("the single match of a search can be changed, and the card ends the turn", async () => {
    script = [
      call("search_transactions", { amount_text: "2,247", date_text: null, text: null, direction: "any", purpose: "act" }),
      call("propose_note", { txn_ref: "T1", note_text: "dinner" }),
    ];
    const out = await turn("add a note dinner to the 2,247 payment");
    expect(modelCalls).toBe(2);
    expect(out.messages.find((m) => m.kind === "op")).toMatchObject({ draft: { op: "note", txnId: "id-etsi", note: "dinner" } });
  });

  test("stops after the step limit", async () => {
    script = Array.from({ length: 12 }, () => call("describe_table", { table: "txn" }));
    const out = await turn("keep going");
    expect(modelCalls).toBe(12);
    expect(out.messages[0]).toMatchObject({ text: "I couldn't finish that. Try asking a different way." });
  });

  test("retries a timeout once", async () => {
    script = [() => ({ ok: false, failure: { kind: "timeout" }, limits: LIMITS }), say("Hello.")];
    const out = await turn("hi");
    expect(modelCalls).toBe(2);
    expect(out.failure).toBeNull();
    expect(out.messages[0]).toMatchObject({ text: "Hello." });
  });
});
