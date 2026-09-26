import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { loadSecretKey, open, seal } from "@/lib/crypto/secret-box";
import type { AiFailure } from "@/lib/ai/failure";
import {
  accessTokenExpiry,
  accountFromIdToken,
  refreshChatgptTokens,
  RefreshError,
} from "./oauth";

const PROVIDER = "chatgpt";
// Codex refreshes 5 minutes ahead; same here.
const REFRESH_WINDOW_MS = 5 * 60_000;

export const sealContext = (userId: string) => `${userId}:${PROVIDER}`;

export type ChatgptAccess =
  | { ok: true; accessToken: string; accountId: string }
  | { ok: false; failure: AiFailure };

type Row = typeof schema.aiConnections.$inferSelect;

const connectionWhere = (userId: string) =>
  and(eq(schema.aiConnections.userId, userId), eq(schema.aiConnections.provider, PROVIDER));

const needsRefresh = (row: Row) =>
  !row.accessExpiresAt || row.accessExpiresAt.getTime() - Date.now() < REFRESH_WINDOW_MS;

/** Postgres "undefined_table" — migration 0011 hasn't been applied to this DB. */
function isMissingTable(err: unknown): boolean {
  const code = (e: unknown) => (e && typeof e === "object" && "code" in e ? (e as { code: unknown }).code : null);
  return code(err) === "42P01" || code((err as { cause?: unknown } | null)?.cause) === "42P01";
}

export async function getChatgptConnectionStatus(
  userId: string,
): Promise<"none" | "active" | "reauth_required" | "not_migrated"> {
  let row: { status: string } | undefined;
  try {
    [row] = await db
      .select({ status: schema.aiConnections.status })
      .from(schema.aiConnections)
      .where(connectionWhere(userId))
      .limit(1);
  } catch (err) {
    if (isMissingTable(err)) return "not_migrated";
    throw err;
  }
  if (!row) return "none";
  return row.status === "active" ? "active" : "reauth_required";
}

/**
 * A usable access token for this user's ChatGPT connection, refreshing it
 * first when it's close to expiry (or `force` after a 401).
 *
 * The refresh runs inside a transaction holding the row lock. Refresh tokens
 * are single-use, so without the lock two concurrent requests could both
 * spend the same one and the loser would kill the connection.
 */
/** Thrown when a stored token can't be decrypted — the key was rotated or is wrong. */
class UnreadableSecret extends Error {}

function unseal(sealed: string, context: string): string {
  try {
    return open(sealed, context);
  } catch {
    throw new UnreadableSecret();
  }
}

/**
 * Like getChatgptAccessUnchecked, but a missing encryption key or tokens that
 * no longer decrypt (e.g. AI_TOKEN_ENCRYPTION_KEY rotated) become a failure the
 * panel can explain, instead of an exception.
 */
export async function getChatgptAccess(
  userId: string,
  opts: { force?: boolean } = {},
): Promise<ChatgptAccess> {
  try {
    loadSecretKey();
  } catch {
    return { ok: false, failure: { kind: "misconfigured" } };
  }
  try {
    return await getChatgptAccessUnchecked(userId, opts);
  } catch (err) {
    if (err instanceof UnreadableSecret) return { ok: false, failure: { kind: "auth_unreadable" } };
    throw err;
  }
}

async function getChatgptAccessUnchecked(
  userId: string,
  opts: { force?: boolean },
): Promise<ChatgptAccess> {
  const context = sealContext(userId);
  const [row] = await db.select().from(schema.aiConnections).where(connectionWhere(userId)).limit(1);
  if (!row) return { ok: false, failure: { kind: "not_connected" } };
  if (row.status !== "active") return { ok: false, failure: { kind: "auth_expired" } };

  if (!opts.force && !needsRefresh(row)) {
    return {
      ok: true,
      accessToken: unseal(row.accessTokenSealed, context),
      accountId: row.providerAccountId,
    };
  }

  return db.transaction(async (tx): Promise<ChatgptAccess> => {
    const [locked] = await tx
      .select()
      .from(schema.aiConnections)
      .where(connectionWhere(userId))
      .for("update");
    if (!locked) return { ok: false, failure: { kind: "not_connected" } };
    if (locked.status !== "active") return { ok: false, failure: { kind: "auth_expired" } };

    // Another request refreshed while we waited for the lock — use its token.
    if (locked.updatedAt.getTime() > row.updatedAt.getTime() && !needsRefresh(locked)) {
      return {
        ok: true,
        accessToken: unseal(locked.accessTokenSealed, context),
        accountId: locked.providerAccountId,
      };
    }

    try {
      const next = await refreshChatgptTokens({
        accessToken: unseal(locked.accessTokenSealed, context),
        refreshToken: unseal(locked.refreshTokenSealed, context),
        idToken: "",
      });
      let planType = locked.planType;
      try {
        planType = accountFromIdToken(next.idToken).planType ?? planType;
      } catch {
        /* refresh may omit the id_token; keep the last known plan */
      }
      await tx
        .update(schema.aiConnections)
        .set({
          accessTokenSealed: seal(next.accessToken, context),
          refreshTokenSealed: seal(next.refreshToken, context),
          accessExpiresAt: accessTokenExpiry(next.accessToken),
          planType,
          updatedAt: new Date(),
        })
        .where(eq(schema.aiConnections.id, locked.id));
      return { ok: true, accessToken: next.accessToken, accountId: locked.providerAccountId };
    } catch (err) {
      if (err instanceof RefreshError && err.permanent) {
        await tx
          .update(schema.aiConnections)
          .set({ status: "reauth_required", updatedAt: new Date() })
          .where(eq(schema.aiConnections.id, locked.id));
        return { ok: false, failure: { kind: "auth_expired" } };
      }
      return { ok: false, failure: { kind: "unavailable", status: null } };
    }
  });
}
