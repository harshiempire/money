import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { UploadForm } from "./UploadForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const user = await requireCurrentUser();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const recent = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.accountId, account.id))
    .orderBy(desc(schema.imports.createdAt))
    .limit(10);

  return (
    <>
      <PageHeader
        title="Import statement"
        description="Upload a Bank of Baroda PDF. Re-uploading the same period inserts zero new rows."
      >
        <Badge tone="neutral">{account.name} · {account.bank}</Badge>
      </PageHeader>

      <Card className="max-w-2xl">
        <UploadForm />
      </Card>

      <div className="mt-10">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Recent imports</h2>
        {recent.length === 0 ? (
          <EmptyState
            className="mt-4"
            title="No imports yet"
            description="Upload your first Bank of Baroda statement to get started."
          />
        ) : (
          <div className="mt-4 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)]">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-overlay)] text-left text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  <th className="px-4 py-3">Filename</th>
                  <th className="px-4 py-3">Period</th>
                  <th className="px-4 py-3 text-right">Seen</th>
                  <th className="px-4 py-3 text-right">New</th>
                  <th className="px-4 py-3">When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-[var(--color-border)] bg-[var(--color-surface-raised)] transition-colors hover:bg-[var(--color-surface-overlay)]/50"
                  >
                    <td className="px-4 py-3 font-mono text-xs">{r.filename}</td>
                    <td className="px-4 py-3 text-xs text-[var(--color-text-secondary)]">
                      {r.periodStart} → {r.periodEnd}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">{r.rowsSeen}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`font-mono text-xs ${r.rowsNew > 0 ? "font-semibold text-[var(--color-credit)]" : "text-[var(--color-text-muted)]"}`}>
                        {r.rowsNew}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-[var(--color-text-muted)]">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
