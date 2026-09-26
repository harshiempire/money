import { describe, expect, test } from "bun:test";
import {
  classifyHttpFailure,
  collectOutputItems,
  functionCalls,
  messageText,
  readLimits,
} from "./responses";

describe("classifyHttpFailure", () => {
  test("usage limit carries the reset time and plan", () => {
    const body = JSON.stringify({
      error: { type: "usage_limit_reached", resets_at: 1790327067, plan_type: "prolite" },
    });
    expect(classifyHttpFailure(429, body)).toEqual({
      kind: "limit_reached",
      resetsAt: new Date(1790327067 * 1000).toISOString(),
      plan: "prolite",
    });
  });

  test("tells a lapsed plan from a spent limit", () => {
    expect(classifyHttpFailure(429, JSON.stringify({ error: { type: "usage_not_included" } }))).toEqual({
      kind: "plan_not_eligible",
    });
  });

  test("other statuses", () => {
    expect(classifyHttpFailure(401, "")).toEqual({ kind: "auth_expired" });
    expect(classifyHttpFailure(403, "<html>cloudflare</html>")).toEqual({ kind: "unavailable", status: 403 });
    expect(classifyHttpFailure(429, "not json")).toEqual({ kind: "rate_limited" });
    expect(classifyHttpFailure(502, "<html>")).toEqual({ kind: "unavailable", status: 502 });
  });
});

describe("output items", () => {
  const event = (o: object) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" };
  const call = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "search_transactions",
    arguments: '{"amount_text":"₹760"}',
  };
  const message = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Found it." }],
  };

  test("collects completed items in order, ignoring deltas", () => {
    const sse =
      event({ type: "response.created" }) +
      event({ type: "response.output_item.done", item: reasoning }) +
      event({ type: "response.output_text.delta", delta: "Fo" }) +
      event({ type: "response.output_item.done", item: call }) +
      event({ type: "response.output_item.done", item: message }) +
      event({ type: "response.completed" });
    const items = collectOutputItems(sse)!;
    expect(items).toEqual([reasoning, call, message]);
    expect(functionCalls(items)).toEqual([
      { callId: "call_1", name: "search_transactions", arguments: '{"amount_text":"₹760"}' },
    ]);
    expect(messageText(items)).toBe("Found it.");
  });

  test("a failed stream returns null", () => {
    expect(collectOutputItems(event({ type: "response.failed" }))).toBeNull();
  });

  test("tolerates CRLF framing and junk lines", () => {
    const sse = `data: not-json\r\n\r\ndata: ${JSON.stringify({ type: "response.output_item.done", item: message })}\r\n\r\n`;
    expect(collectOutputItems(sse)).toEqual([message]);
  });
});

test("readLimits reads the spike's headers", () => {
  const h = new Headers({
    "x-codex-primary-used-percent": "82",
    "x-codex-primary-reset-at": "1790327067",
    "x-codex-primary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "",
  });
  expect(readLimits(h)).toEqual({
    usedPercent: 82,
    resetsAt: new Date(1790327067 * 1000).toISOString(),
    windowMinutes: 10080,
  });
});
