/**
 * The ChatGPT Codex backend's Responses endpoint, as the Codex CLI speaks it
 * (codex-rs/codex-api). `store: false`, so the caller keeps the conversation:
 * every output item is replayed verbatim on the next step, reasoning included
 * (`include: ["reasoning.encrypted_content"]`).
 *
 * Returns typed failures instead of throwing so the caller can always fall
 * back to the AI-free path.
 */
import type { AiFailure, AiLimits } from "@/lib/ai/failure";
import { CHATGPT_CODEX_BASE_URL, CHATGPT_ORIGINATOR } from "./oauth";

/** A Responses input/output item (message, function_call, reasoning, …). */
export type ResponseItem = { type: string } & Record<string, unknown>;

export interface FunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: object;
  strict: boolean;
}

export interface FunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export type AgentStepResult =
  | { ok: true; items: ResponseItem[]; text: string; calls: FunctionCall[]; limits: AiLimits }
  | { ok: false; failure: AiFailure; limits: AiLimits };

export function readLimits(headers: Headers): AiLimits {
  const num = (name: string) => {
    const v = headers.get(name);
    return v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
  };
  const resetAt = num("x-codex-primary-reset-at");
  return {
    usedPercent: num("x-codex-primary-used-percent"),
    resetsAt: resetAt !== null ? new Date(resetAt * 1000).toISOString() : null,
    windowMinutes: num("x-codex-primary-window-minutes"),
  };
}

/** Mirrors codex-rs/codex-api/src/api_bridge.rs error mapping. */
export function classifyHttpFailure(status: number, body: string): AiFailure {
  let error: { type?: string; code?: string; resets_at?: number; plan_type?: string } = {};
  try {
    error = JSON.parse(body).error ?? {};
  } catch {}
  // 403 from chatgpt.com is usually an edge/policy block, not a stale login,
  // so it reads as "unavailable" rather than asking for a reconnect.
  if (status === 401) return { kind: "auth_expired" };
  if (error.type === "usage_not_included") return { kind: "plan_not_eligible" };
  if (status === 429 && error.type === "usage_limit_reached") {
    return {
      kind: "limit_reached",
      resetsAt: typeof error.resets_at === "number" ? new Date(error.resets_at * 1000).toISOString() : null,
      plan: error.plan_type ?? null,
    };
  }
  if (status === 429) return { kind: "rate_limited" };
  return { kind: "unavailable", status };
}

/**
 * Completed output items from an SSE body, in order. Null when the stream
 * reported failure. Uses `response.output_item.done` like Codex does.
 */
export function collectOutputItems(sse: string): ResponseItem[] | null {
  const items: ResponseItem[] = [];
  for (const event of sse.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    if (!data || data === "[DONE]") continue;
    let parsed: { type?: string; item?: unknown };
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (parsed.type === "response.failed" || parsed.type === "error") return null;
    if (
      parsed.type === "response.output_item.done" &&
      parsed.item &&
      typeof parsed.item === "object" &&
      typeof (parsed.item as { type?: unknown }).type === "string"
    ) {
      items.push(parsed.item as ResponseItem);
    }
  }
  return items;
}

export function messageText(items: ResponseItem[]): string {
  return items
    .filter((i) => i.type === "message")
    .flatMap((i) => (Array.isArray(i.content) ? i.content : []))
    .filter((c): c is { type: string; text: string } => c?.type === "output_text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

export function functionCalls(items: ResponseItem[]): FunctionCall[] {
  return items
    .filter((i) => i.type === "function_call")
    .map((i) => ({
      callId: String(i.call_id ?? ""),
      name: String(i.name ?? ""),
      arguments: typeof i.arguments === "string" ? i.arguments : "{}",
    }))
    .filter((c) => c.callId && c.name);
}

const EMPTY_LIMITS: AiLimits = { usedPercent: null, resetsAt: null, windowMinutes: null };

const timedOut = (err: unknown) => err instanceof DOMException && err.name === "TimeoutError";

/** One model step: send the conversation so far, get back its new items. */
export async function callAgentStep(input: {
  accessToken: string;
  accountId: string;
  model: string;
  instructions: string;
  input: ResponseItem[];
  tools: FunctionTool[];
  sessionId: string;
  timeoutMs?: number;
}): Promise<AgentStepResult> {
  let res: Response;
  try {
    res = await fetch(`${CHATGPT_CODEX_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "chatgpt-account-id": input.accountId,
        originator: CHATGPT_ORIGINATOR,
        "OpenAI-Beta": "responses=experimental",
        session_id: input.sessionId,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: input.model,
        instructions: input.instructions,
        input: input.input,
        tools: input.tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        reasoning: { effort: "low" },
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
    });
  } catch (err) {
    return {
      ok: false,
      failure: timedOut(err) ? { kind: "timeout" } : { kind: "unavailable", status: null },
      limits: EMPTY_LIMITS,
    };
  }

  const limits = readLimits(res.headers);
  if (!res.ok) {
    return { ok: false, failure: classifyHttpFailure(res.status, await res.text()), limits };
  }

  let items: ResponseItem[] | null;
  try {
    items = collectOutputItems(await res.text());
  } catch (err) {
    return {
      ok: false,
      failure: timedOut(err) ? { kind: "timeout" } : { kind: "unavailable", status: null },
      limits,
    };
  }
  if (items === null) return { ok: false, failure: { kind: "unavailable", status: res.status }, limits };

  return { ok: true, items, text: messageText(items), calls: functionCalls(items), limits };
}
