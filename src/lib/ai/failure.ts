/**
 * Every way the assistant's model call can fail, as something the UI can
 * explain. When the subscription path stops working the user should learn
 * *why* — limit, sign-in, plan, or OpenAI changing something — not just that
 * it broke.
 */

export type AiFailure =
  | { kind: "disabled" }
  | { kind: "not_connected" }
  | { kind: "auth_expired" }
  | { kind: "auth_unreadable" }
  | { kind: "misconfigured" }
  | { kind: "limit_reached"; resetsAt: string | null; plan: string | null }
  | { kind: "plan_not_eligible" }
  | { kind: "rate_limited" }
  | { kind: "timeout" }
  | { kind: "unavailable"; status: number | null }
  | { kind: "bad_output" };

export interface AiLimits {
  usedPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
}

const formatIst = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

export function describeFailure(f: AiFailure): string {
  switch (f.kind) {
    case "disabled":
      return "AI reading isn't turned on for this account.";
    case "not_connected":
      return "ChatGPT isn't connected yet. Run `bun run connect-chatgpt`.";
    case "auth_unreadable":
      return "The stored ChatGPT sign-in can't be decrypted (the encryption key changed). Reconnect with `bun run connect-chatgpt`.";
    case "misconfigured":
      return "AI_TOKEN_ENCRYPTION_KEY isn't set to a 32-byte base64 key on this server.";
    case "auth_expired":
      return "The ChatGPT sign-in expired or was revoked. Reconnect with `bun run connect-chatgpt`.";
    case "limit_reached":
      return f.resetsAt
        ? `Your ChatGPT usage limit is used up. It resets ${formatIst(f.resetsAt)}.`
        : "Your ChatGPT usage limit is used up.";
    case "plan_not_eligible":
      return "Your ChatGPT plan no longer includes this. Check the subscription is active.";
    case "rate_limited":
      return "ChatGPT is rate-limiting requests right now. Try again in a minute.";
    case "timeout":
      return "ChatGPT took too long to answer.";
    case "unavailable":
      return `ChatGPT couldn't be reached${f.status ? ` (HTTP ${f.status})` : ""}. OpenAI may have changed something.`;
    case "bad_output":
      return "ChatGPT's answer didn't have the expected shape, so it was ignored.";
  }
}
