"use server";

import { revalidatePath } from "next/cache";
import { LedgerError } from "@/lib/ledger/context";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { createToken, listTokens, revokeToken } from "@/lib/mcp/token-store";
import type { McpScope } from "@/lib/mcp/token";

export async function listMcpTokens(): Promise<
  Array<{
    id: string;
    name: string;
    hint: string;
    scope: McpScope;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }>
> {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  return listTokens({
    userId: user.id,
    accountId: account.id,
  });
}

export async function createMcpToken(input: { name: string; scope: McpScope }): Promise<
  | {
      ok: true;
      token: string;
      hint: string;
      id: string;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  return createToken(
    {
      userId: user.id,
      accountId: account.id,
    },
    input,
  );
}

export async function revokeMcpToken(input: { id: string }): Promise<
  | { ok: true }
  | {
      ok: false;
      error: string;
    }
> {
  const user = await requireCurrentUserAction();
  if (typeof input?.id !== "string" || !input.id)
    return {
      ok: false,
      error: "Choose a token first.",
    };
  const account = await getOrCreateAccountForBank(user.id, "bob");
  return revokeToken(
    {
      userId: user.id,
      accountId: account.id,
    },
    input.id,
  );
}

export async function listLedgerChanges(input?: { before?: string }) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const before = typeof input?.before === "string" && input.before ? input.before : undefined;
  try {
    const { listChanges } = await import("@/lib/ledger/changes");
    const page = await listChanges({ userId: user.id, accountId: account.id }, { limit: 20, before });
    return { available: true as const, nextCursor: page.nextCursor, rows: page.rows.map((row) => ({
      id: row.id, at: row.createdAt.toISOString(), by: row.sourceLabel, summary: row.summary,
      kind: row.kind, count: row.ops.length, undone: row.undoneByChangeId !== null,
    })) };
  } catch (e) {
    if (e instanceof LedgerError && e.code === "migration_required")
      return { available: false as const, nextCursor: null, rows: [] };
    throw e;
  }
}

export async function undoLedgerChange(input: { changeId: string }) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  if (typeof input?.changeId !== "string" || !input.changeId) return { ok: false, error: "Choose a change first." };
  try {
    const { undoChange } = await import("@/lib/ledger/undo");
    const result = await undoChange({ actor: { userId: user.id, accountId: account.id }, source: "app" }, input.changeId);
    if (result.stale?.length) return { ok: false, error: "Nothing was undone. A transaction or payee default changed after this change. Review the latest values first." };
    revalidatePath("/transactions"); revalidatePath("/"); revalidatePath("/connections");
    return { ok: true };
  } catch (e) {
    if (e instanceof LedgerError) return { ok: false, error: e.message };
    throw e;
  }
}
