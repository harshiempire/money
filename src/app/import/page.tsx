import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { PageShell } from "@/components/PageShell";
import {
  DataTable,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from "@/components/ui/DataTable";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { UploadForm } from "./UploadForm";

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
    <PageShell
      title="Import statement"
      width="2xl"
      description="Upload a Bank of Baroda PDF. Re-uploading the same period inserts zero new rows."
    >
      <Card padding="sm" className="mt-4 text-xs text-neutral-500">
        Account: <strong className="font-medium">{account.name}</strong> (
        {account.bank})
      </Card>

      <Card className="mt-6 border-dashed">
        <UploadForm />
      </Card>

      <Section title="Recent imports" className="mt-10">
        {recent.length === 0 ? (
          <p className="text-sm text-neutral-500">No imports yet.</p>
        ) : (
          <DataTable>
            <DataTableHead>
              <tr>
                <DataTableHeaderCell>Filename</DataTableHeaderCell>
                <DataTableHeaderCell>Period</DataTableHeaderCell>
                <DataTableHeaderCell align="right">Seen</DataTableHeaderCell>
                <DataTableHeaderCell align="right">New</DataTableHeaderCell>
                <DataTableHeaderCell>When</DataTableHeaderCell>
              </tr>
            </DataTableHead>
            <tbody>
              {recent.map((r) => (
                <DataTableRow key={r.id}>
                  <DataTableCell className="font-mono text-xs">
                    {r.filename}
                  </DataTableCell>
                  <DataTableCell className="text-xs">
                    {r.periodStart} → {r.periodEnd}
                  </DataTableCell>
                  <DataTableCell align="right">{r.rowsSeen}</DataTableCell>
                  <DataTableCell align="right">{r.rowsNew}</DataTableCell>
                  <DataTableCell className="text-xs text-neutral-500">
                    {new Date(r.createdAt).toLocaleString()}
                  </DataTableCell>
                </DataTableRow>
              ))}
            </tbody>
          </DataTable>
        )}
      </Section>
    </PageShell>
  );
}
