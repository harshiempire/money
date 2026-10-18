import { AppShell } from "@/components/AppShell";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { listMcpTokens } from "./actions";
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

  return (
    <AppShell title="Connections" width="narrow">
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Tokens let tools such as Claude Code read your Money data and propose category tags. No tags are saved
        until you review them in Ask Money and press Apply.
      </p>
      <Connections initialTokens={tokens} initialError={error} />
    </AppShell>
  );
}
