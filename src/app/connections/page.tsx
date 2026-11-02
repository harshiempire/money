import { AppShell } from "@/components/AppShell";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { listLedgerChanges, listMcpTokens } from "./actions";
import { RecentChanges } from "./RecentChanges";
import { Connections } from "./Connections";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  await requireCurrentUser();
  let tokens: Awaited<ReturnType<typeof listMcpTokens>> = [];
  let error: string | undefined;
  try {
    tokens = await listMcpTokens();
  } catch (e) {
    error = e instanceof Error ? e.message : "Couldn't load connections. Try again.";
  }

  const changes = await listLedgerChanges();

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
