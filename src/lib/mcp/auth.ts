import { Effect, Schema } from "effect";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
import { hashMcpToken, McpScope, parseMcpBearer } from "./token";

export interface McpPrincipal {
  actor: MoneyActor;
  scope: McpScope;
  tokenId: string;
  label: string;
}
export interface TokenLookup {
  id: string;
  userId: string;
  accountId: string;
  accountUserId: string;
  name: string;
  scope: string;
  userTokenVersion: number;
  currentTokenVersion: number;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}
export interface McpAuthDeps {
  configured: boolean;
  lookup(hash: string): Promise<TokenLookup | null>;
  rateLimit(id: string): Promise<
    | { ok: true }
    | {
        ok: false;
        retryAfterSeconds: number;
      }
  >;
  now(): Date;
  touch(id: string, actor: MoneyActor, now: Date): Promise<void>;
}
export class McpMissingToken extends Schema.TaggedError<McpMissingToken>()("McpMissingToken", {}) {}
export class McpInvalidToken extends Schema.TaggedError<McpInvalidToken>()("McpInvalidToken", {}) {}
export class McpNotConfigured extends Schema.TaggedError<McpNotConfigured>()("McpNotConfigured", {}) {}
export class McpRateLimited extends Schema.TaggedError<McpRateLimited>()("McpRateLimited", {
  retryAfterSeconds: Schema.Int,
}) {}
export class McpAuthUnavailable extends Schema.TaggedError<McpAuthUnavailable>()("McpAuthUnavailable", {}) {}

export const authenticateMcpRequestCore = Effect.fn("authenticateMcpRequest")(function* (
  request: Request,
  deps: McpAuthDeps,
) {
  if (!deps.configured) return yield* new McpNotConfigured();
  const header = request.headers.get("authorization");
  if (header === null) return yield* new McpMissingToken();
  const token = parseMcpBearer(header);
  if (!token) return yield* new McpInvalidToken();
  const row = yield* Effect.tryPromise({
    try: () => deps.lookup(hashMcpToken(token)),
    catch: () => new McpAuthUnavailable(),
  });
  if (
    !row ||
    row.revokedAt ||
    row.userTokenVersion !== row.currentTokenVersion ||
    row.accountUserId !== row.userId ||
    !Schema.is(McpScope)(row.scope)
  ) {
    return yield* new McpInvalidToken();
  }
  const limit = yield* Effect.tryPromise({
    try: () => deps.rateLimit(row.id),
    catch: () => new McpAuthUnavailable(),
  });
  if (!limit.ok) return yield* new McpRateLimited({ retryAfterSeconds: limit.retryAfterSeconds });
  const actor = {
    userId: row.userId,
    accountId: row.accountId,
  };
  const now = deps.now();
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= 60_000) {
    yield* Effect.tryPromise(() => deps.touch(row.id, actor, now)).pipe(Effect.catch(() => Effect.void));
  }
  return {
    actor,
    scope: row.scope,
    tokenId: row.id,
    label: row.name,
  } satisfies McpPrincipal;
});

export async function authenticateMcpRequest(request: Request) {
  if (!process.env.AUTH_SECRET) return Effect.runPromise(Effect.fail(new McpNotConfigured()));
  const [{ lookupMcpToken, touchMcpToken }, { checkMcpTokenRateLimit }] = await Promise.all([
    import("./token-store"),
    import("@/lib/rate-limit"),
  ]);
  return Effect.runPromise(
    authenticateMcpRequestCore(request, {
      configured: true,
      lookup: lookupMcpToken,
      rateLimit: checkMcpTokenRateLimit,
      now: () => new Date(),
      touch: touchMcpToken,
    }),
  );
}
