/**
 * Who may use AI reading, and with which model. Personal project for now:
 * an allowlist of user ids in AI_ALLOWED_USER_IDS (comma-separated), empty
 * by default. Each allowed user still needs their own ChatGPT connection —
 * nobody's requests ever run on someone else's subscription.
 */

export function isAiAllowed(userId: string, raw = process.env.AI_ALLOWED_USER_IDS): boolean {
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(userId);
}

/** Smallest tier by default so Money barely touches the plan's limit. */
export const assistantModel = () => process.env.MONEY_AI_MODEL?.trim() || "gpt-6-luna";
