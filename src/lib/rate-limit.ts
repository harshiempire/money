import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

let warnedMissing = false;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (process.env.NODE_ENV !== "production" && !warnedMissing) {
      warnedMissing = true;
      console.warn(
        "[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN not set — login/register limits disabled; MCP uses a per-instance limit",
      );
    }
    return null;
  }
  return new Redis({ url, token });
}

function limiter(
  prefix: string,
  limit: number,
  window: `${number} ${"s" | "m" | "h" | "d"}`,
) {
  const redis = getRedis();
  if (!redis) return null;
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(limit, window),
    prefix: `money:${prefix}`,
  });
}

export async function checkLoginRateLimit(
  ip: string,
  email: string,
): Promise<boolean> {
  const ipRedis = getRedis();
  if (!ipRedis) return true;
  const ipLim = new Ratelimit({
    redis: ipRedis,
    limiter: Ratelimit.slidingWindow(10, "15 m"),
    prefix: "money:login-ip",
  });
  const emailLim = new Ratelimit({
    redis: ipRedis,
    limiter: Ratelimit.slidingWindow(5, "15 m"),
    prefix: "money:login-email",
  });
  const [byIp, byEmail] = await Promise.all([
    ipLim.limit(ip),
    emailLim.limit(email.toLowerCase()),
  ]);
  return byIp.success && byEmail.success;
}

export async function checkRegisterRateLimit(ip: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  const lim = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(5, "1 h"),
    prefix: "money:register-ip",
  });
  const result = await lim.limit(ip);
  return result.success;
}

/** Assistant calls spend the owner's ChatGPT limit; keep a runaway tab from draining it. */
export async function checkAssistantRateLimit(userId: string): Promise<boolean> {
  const lim = limiter("assistant-user", 30, "10 m");
  if (!lim) return true;
  const result = await lim.limit(userId);
  return result.success;
}

const mcpWindows = new Map<string, { count: number; reset: number }>();

export async function checkMcpTokenRateLimit(
  tokenId: string,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const now = Date.now();
  const lim = limiter("mcp-token", 60, "1 m");
  if (lim) {
    const result = await lim.limit(tokenId);
    return result.success ? { ok: true } : { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((result.reset - now) / 1000)) };
  }
  // Best-effort per instance when Redis is unset; other instances have their own window.
  for (const [id, window] of mcpWindows) if (window.reset <= now) mcpWindows.delete(id);
  let window = mcpWindows.get(tokenId);
  if (!window) {
    window = { count: 0, reset: now + 60_000 };
    mcpWindows.set(tokenId, window);
  }
  if (window.count >= 60) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((window.reset - now) / 1000)) };
  window.count++;
  return { ok: true };
}
