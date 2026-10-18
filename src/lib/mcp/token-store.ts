import "server-only";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { Schema } from "effect";
import { db, schema } from "@/db";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
import { isMissingTable } from "@/lib/db/pg-errors";
import { generateMcpToken, hashMcpToken, McpScope } from "./token";
import type { TokenLookup } from "./auth";

const t = schema.mcpTokens;
const scoped = (actor: MoneyActor) => and(eq(t.userId, actor.userId), eq(t.accountId, actor.accountId));
const unavailable = "Tokens aren't available until migration 0013 is applied.";
export const TokenInput = Schema.Struct({
  name: Schema.String,
  scope: McpScope,
});

export async function lookupMcpToken(hash: string): Promise<TokenLookup | null> {
  try {
    const [row] = await db
      .select({
        id: t.id,
        userId: t.userId,
        accountId: t.accountId,
        name: t.name,
        scope: t.scope,
        userTokenVersion: t.userTokenVersion,
        currentTokenVersion: schema.users.tokenVersion,
        accountUserId: schema.moneyAccounts.userId,
        revokedAt: t.revokedAt,
        lastUsedAt: t.lastUsedAt,
      })
      .from(t)
      .innerJoin(schema.users, eq(t.userId, schema.users.id))
      .innerJoin(
        schema.moneyAccounts,
        and(eq(t.accountId, schema.moneyAccounts.id), eq(t.userId, schema.moneyAccounts.userId)),
      )
      .where(eq(t.tokenHash, hash))
      .limit(1);
    return row ?? null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

export async function touchMcpToken(id: string, actor: MoneyActor, now: Date): Promise<void> {
  await db
    .update(t)
    .set({ lastUsedAt: now })
    .where(
      and(
        scoped(actor),
        eq(t.id, id),
        isNull(t.revokedAt),
        or(isNull(t.lastUsedAt), lt(t.lastUsedAt, new Date(now.getTime() - 60_000))),
      ),
    );
}

export async function listTokens(actor: MoneyActor) {
  try {
    const rows = await db
      .select({
        id: t.id,
        name: t.name,
        hint: t.tokenHint,
        scope: t.scope,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        revokedAt: t.revokedAt,
      })
      .from(t)
      .where(scoped(actor))
      .orderBy(desc(t.createdAt));
    return rows.flatMap((r) =>
      Schema.is(McpScope)(r.scope)
        ? [
            {
              ...r,
              scope: r.scope,
              createdAt: r.createdAt.toISOString(),
              lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
              revokedAt: r.revokedAt?.toISOString() ?? null,
            },
          ]
        : [],
    );
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

export async function createToken(actor: MoneyActor, input: unknown) {
  if (!Schema.is(TokenInput)(input))
    return {
      ok: false,
      error: "Choose a name and a read or propose scope.",
    } as const;
  const name = input.name.trim();
  if (name.length < 1 || name.length > 40)
    return {
      ok: false,
      error: "Use a token name between 1 and 40 characters.",
    } as const;
  try {
    return await db.transaction(async (tx) => {
      // Serialize creates for the same user so concurrent requests cannot exceed the cap.
      const [user] = await tx
        .select({ tokenVersion: schema.users.tokenVersion })
        .from(schema.users)
        .where(eq(schema.users.id, actor.userId))
        .for("update");
      const [account] = await tx
        .select({ id: schema.moneyAccounts.id })
        .from(schema.moneyAccounts)
        .where(
          and(eq(schema.moneyAccounts.id, actor.accountId), eq(schema.moneyAccounts.userId, actor.userId)),
        );
      if (!user || !account)
        return {
          ok: false,
          error: "That account isn't available.",
        } as const;
      const active = await tx
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.userId, actor.userId), isNull(t.revokedAt)))
        .limit(10);
      if (active.length >= 10)
        return {
          ok: false,
          error: "Revoke a token first. You can have up to 10 active tokens.",
        } as const;
      const token = generateMcpToken();
      const hint = token.slice(0, 8);
      const [created] = await tx
        .insert(t)
        .values({
          userId: actor.userId,
          accountId: actor.accountId,
          name,
          scope: input.scope,
          tokenHash: hashMcpToken(token),
          tokenHint: hint,
          userTokenVersion: user.tokenVersion,
        })
        .returning({ id: t.id });
      return {
        ok: true,
        token,
        hint,
        id: created.id,
      } as const;
    });
  } catch (error) {
    if (isMissingTable(error))
      return {
        ok: false,
        error: unavailable,
      } as const;
    throw error;
  }
}

export async function revokeToken(actor: MoneyActor, id: string) {
  try {
    const [row] = await db
      .update(t)
      .set({ revokedAt: new Date() })
      .where(and(scoped(actor), eq(t.id, id), isNull(t.revokedAt)))
      .returning({ id: t.id });
    if (row) return { ok: true } as const;
    const [existing] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(scoped(actor), eq(t.id, id)))
      .limit(1);
    return existing
      ? ({ ok: true } as const)
      : ({
          ok: false,
          error: "That token isn't available.",
        } as const);
  } catch (error) {
    if (isMissingTable(error))
      return {
        ok: false,
        error: unavailable,
      } as const;
    throw error;
  }
}
