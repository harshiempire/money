import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
import { isMissingTable } from "@/lib/db/pg-errors";
import type { McpPrincipal } from "./auth";
import { decodeStoredTagRows, type StoredTagRow } from "./proposal";
import { McpToolError } from "./pagination";

const t = schema.mcpTagDrafts;
const scoped = (actor: MoneyActor) => and(eq(t.userId, actor.userId), eq(t.accountId, actor.accountId));
export const DRAFTS_UNAVAILABLE = "Proposed tags aren't available until migration 0013 is applied.";
export interface ProposedDraftSummary {
  id: string;
  sourceLabel: string;
  title: string | null;
  rowCount: number;
  createdAt: string;
}

export async function storeProposedDraft(
  principal: McpPrincipal,
  input: {
    rows: StoredTagRow[];
    title: string | null;
    rejectedCount: number;
  },
): Promise<void> {
  const { actor } = principal;
  try {
    await db.transaction(async (tx) => {
      const [user] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, actor.userId))
        .for("update");
      const [account] = await tx
        .select({ id: schema.moneyAccounts.id })
        .from(schema.moneyAccounts)
        .where(
          and(eq(schema.moneyAccounts.id, actor.accountId), eq(schema.moneyAccounts.userId, actor.userId)),
        );
      if (!user || !account) throw new McpToolError("That account isn't available.");
      const pending = await tx
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.userId, actor.userId), eq(t.status, "pending")))
        .limit(20);
      if (pending.length >= 20)
        throw new McpToolError("You have 20 pending drafts. Apply or dismiss one in Money first.");
      await tx.insert(t).values({
        userId: actor.userId,
        accountId: actor.accountId,
        tokenId: principal.tokenId,
        sourceLabel: principal.label,
        title: input.title,
        rows: input.rows,
        rejectedCount: input.rejectedCount,
      });
    });
  } catch (error) {
    if (isMissingTable(error)) throw new McpToolError(DRAFTS_UNAVAILABLE);
    throw error;
  }
}

export async function listDrafts(actor: MoneyActor): Promise<ProposedDraftSummary[]> {
  try {
    const rows = await db
      .select()
      .from(t)
      .where(and(scoped(actor), eq(t.status, "pending")))
      .orderBy(desc(t.createdAt));
    return rows.map((r) => ({
      id: r.id,
      sourceLabel: r.sourceLabel,
      title: r.title,
      rowCount: decodeStoredTagRows(r.rows).rows.length,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

export async function loadDraft(actor: MoneyActor, id: string) {
  try {
    const [row] = await db
      .select()
      .from(t)
      .where(and(scoped(actor), eq(t.id, id), eq(t.status, "pending")))
      .limit(1);
    return row
      ? {
          ...row,
          ...decodeStoredTagRows(row.rows),
        }
      : null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

export async function resolveDraft(actor: MoneyActor, id: string, status: "applied" | "dismissed") {
  try {
    const [row] = await db
      .update(t)
      .set({
        status,
        resolvedAt: new Date(),
      })
      .where(and(scoped(actor), eq(t.id, id), eq(t.status, "pending")))
      .returning({ id: t.id });
    return row
      ? ({ ok: true } as const)
      : ({
          ok: false,
          error: "That pending draft isn't available.",
        } as const);
  } catch (error) {
    if (isMissingTable(error))
      return {
        ok: false,
        error: DRAFTS_UNAVAILABLE,
      } as const;
    throw error;
  }
}
