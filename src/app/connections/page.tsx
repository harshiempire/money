import { AppShell } from "@/components/AppShell";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { listTokens } from "@/lib/mcp/token-store";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { readLedgerChanges } from "./connection-handlers";
import { RecentChanges } from "./RecentChanges";
import { Connections } from "./Connections";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const user = await requireCurrentUser();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const actor = { userId: user.id, accountId: account.id };
  let tokens: Awaited<ReturnType<typeof listTokens>> = [];
  let error: string | undefined;
  try {
    tokens = await listTokens(actor);
  } catch (e) {
    error = e instanceof Error ? e.message : "Couldn't load connections. Try again.";
  }

  const changes = await readLedgerChanges(actor);

  return (
    <AppShell title="Connections" width="narrow">
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Tokens let tools such as Claude Code read your Money data, propose tags for review, or change
        categories, notes and flags directly with write access.
      </p>
      <Connections initialTokens={tokens} initialError={error} />
      <RecentChanges initial={changes} />
    </AppShell>
  );
}
