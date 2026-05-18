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
        "[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN not set — rate limiting disabled",
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
