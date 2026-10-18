"use server";

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
