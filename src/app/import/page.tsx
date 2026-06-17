import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { AppShell } from "@/components/AppShell";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { UploadForm } from "./UploadForm";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const user = await requireCurrentUser();

  // Fetch recent imports across all accounts belonging to this user.
  const recent = await db
    .select({
      id: schema.imports.id,
      filename: schema.imports.filename,
      bank: schema.imports.bank,
      periodStart: schema.imports.periodStart,
      periodEnd: schema.imports.periodEnd,
      rowsSeen: schema.imports.rowsSeen,
      rowsNew: schema.imports.rowsNew,
      createdAt: schema.imports.createdAt,
    })
    .from(schema.imports)
    .innerJoin(
      schema.moneyAccounts,
      eq(schema.imports.accountId, schema.moneyAccounts.id),
    )
    .where(eq(schema.moneyAccounts.userId, user.id))
    .orderBy(desc(schema.imports.createdAt))
    .limit(10);

  return (
    <AppShell title="Import statement" width="narrow">
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Upload a bank statement PDF. The bank is detected automatically — Bank
        of Baroda and Axis Bank are supported. Re-uploading the same period
        inserts zero new rows.
      </p>

      <div className="mt-6">
        <UploadForm />
      </div>

      <h2 className="mt-10 text-lg font-semibold">Recent imports</h2>
      {recent.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">No imports yet.</p>
      ) : (
        <table className="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-neutral-500">
              <th className="py-2 pr-3">Filename</th>
              <th className="py-2 pr-3">Bank</th>
              <th className="py-2 pr-3">Period</th>
              <th className="py-2 pr-3 text-right">Seen</th>
              <th className="py-2 pr-3 text-right">New</th>
              <th className="py-2">When</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr
                key={r.id}
                className="border-t border-neutral-200 dark:border-neutral-800"
              >
                <td className="py-2 pr-3 font-mono text-xs">{r.filename}</td>
                <td className="py-2 pr-3 text-xs uppercase">{r.bank}</td>
                <td className="py-2 pr-3 text-xs">
                  {r.periodStart} → {r.periodEnd}
                </td>
                <td className="py-2 pr-3 text-right">{r.rowsSeen}</td>
                <td className="py-2 pr-3 text-right">{r.rowsNew}</td>
                <td className="py-2 text-xs text-neutral-500">
                  {new Date(r.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AppShell>
  );
}
