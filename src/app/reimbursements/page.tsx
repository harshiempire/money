import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { ensureDefaultBobAccount } from "@/db/seed-account";
import { counterpartyLabel, formatDate, formatPaise } from "@/lib/format";

export const dynamic = "force-dynamic";

interface ParticipantRow {
  participantId: string;
  personName: string;
  expectedPaise: number;
  settledPaise: number;
  outstandingPaise: number;
  ageDays: number;
  txnDate: string;
  txnDescription: string;
  txnId: string;
}

const today = new Date();
const ageBucket = (days: number): string => {
  if (days <= 7) return "0–7 days";
  if (days <= 30) return "8–30 days";
  if (days <= 60) return "31–60 days";
  return "60+ days";
};

export default async function ReimbursementsPage() {
  const account = await ensureDefaultBobAccount();

  // Splits attached to transactions in this account.
  const splitsRaw = await db
    .select({
      splitId: schema.splits.id,
      transactionId: schema.splits.transactionId,
      txnDate: schema.transactions.txnDate,
      rawDescription: schema.transactions.rawDescription,
    })
    .from(schema.splits)
    .innerJoin(
      schema.transactions,
      eq(schema.splits.transactionId, schema.transactions.id),
    )
    .where(eq(schema.transactions.accountId, account.id));

  const splitIds = splitsRaw.map((s) => s.splitId);
  const participants = splitIds.length
    ? await db
        .select()
        .from(schema.splitParticipants)
        .where(inArray(schema.splitParticipants.splitId, splitIds))
    : [];

  const settlementsByParticipant = new Map<string, number>();
  if (participants.length > 0) {
    const sets = await db
      .select({
        splitParticipantId: schema.settlements.splitParticipantId,
        amountPaise: schema.settlements.amountPaise,
      })
      .from(schema.settlements)
      .where(
        inArray(
          schema.settlements.splitParticipantId,
          participants.map((p) => p.id),
        ),
      );
    for (const s of sets) {
      settlementsByParticipant.set(
        s.splitParticipantId,
        (settlementsByParticipant.get(s.splitParticipantId) ?? 0) +
          Number(s.amountPaise),
      );
    }
  }

  const splitMeta = new Map(splitsRaw.map((s) => [s.splitId, s]));

  const rows: ParticipantRow[] = participants.map((p) => {
    const meta = splitMeta.get(p.splitId)!;
    const expected = Number(p.expectedAmountPaise);
    const settled = settlementsByParticipant.get(p.id) ?? 0;
    const dt = new Date(meta.txnDate);
    const ageDays = Math.max(
      0,
      Math.floor((today.getTime() - dt.getTime()) / (1000 * 60 * 60 * 24)),
    );
    return {
      participantId: p.id,
      personName: p.personName,
      expectedPaise: expected,
      settledPaise: settled,
      outstandingPaise: Math.max(0, expected - settled),
      ageDays,
      txnDate: meta.txnDate,
      txnDescription: counterpartyLabel(meta.rawDescription),
      txnId: meta.transactionId,
    };
  });

  const outstanding = rows.filter((r) => r.outstandingPaise > 0);
  const settled = rows.filter((r) => r.outstandingPaise === 0);

  // Ageing summary across outstanding rows.
  const buckets = new Map<string, { count: number; total: number }>();
  for (const r of outstanding) {
    const k = ageBucket(r.ageDays);
    const entry = buckets.get(k) ?? { count: 0, total: 0 };
    entry.count += 1;
    entry.total += r.outstandingPaise;
    buckets.set(k, entry);
  }
  const totalOutstanding = outstanding.reduce(
    (s, r) => s + r.outstandingPaise,
    0,
  );

  return (
    <main className="mx-auto max-w-5xl p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Reimbursements</h1>
        <nav className="flex gap-4 text-sm text-neutral-600 dark:text-neutral-400">
          <a href="/" className="underline-offset-4 hover:underline">
            Dashboard
          </a>
          <a href="/transactions" className="underline-offset-4 hover:underline">
            Transactions
          </a>
          <a href="/timeline" className="underline-offset-4 hover:underline">
            Timeline
          </a>
        </nav>
      </header>

      <p className="mt-1 text-xs text-neutral-500">
        People who still owe you, grouped by how long the split has been
        open. Settle inflows from <a className="underline" href="/transactions">/transactions</a>.
      </p>

      <section className="mt-6">
        <div className="text-xs uppercase tracking-wide text-neutral-500">
          Total outstanding
        </div>
        <div className="mt-1 font-mono text-3xl">
          {formatPaise(totalOutstanding)}
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          {outstanding.length} participant
          {outstanding.length === 1 ? "" : "s"} across {splitsRaw.length} split
          {splitsRaw.length === 1 ? "" : "s"}.
        </p>
      </section>

      {buckets.size > 0 && (
        <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          {["0–7 days", "8–30 days", "31–60 days", "60+ days"].map((label) => {
            const b = buckets.get(label);
            return (
              <div
                key={label}
                className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
              >
                <div className="text-xs uppercase text-neutral-500">{label}</div>
                <div className="mt-1 font-mono text-base">
                  {b ? formatPaise(b.total) : "—"}
                </div>
                <div className="text-[10px] text-neutral-500">
                  {b ? `${b.count} pending` : "none"}
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Outstanding</h2>
        {outstanding.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            Nothing pending. {rows.length === 0 && "No splits recorded yet."}
          </p>
        ) : (
          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
                <th className="py-2 pr-3">Person</th>
                <th className="py-2 pr-3">Split</th>
                <th className="py-2 pr-3 text-right">Expected</th>
                <th className="py-2 pr-3 text-right">Settled</th>
                <th className="py-2 pr-3 text-right">Outstanding</th>
                <th className="py-2 pr-3 text-right">Age</th>
              </tr>
            </thead>
            <tbody>
              {outstanding
                .slice()
                .sort((a, b) => b.ageDays - a.ageDays)
                .map((r) => (
                  <tr
                    key={r.participantId}
                    className="border-t border-neutral-200 dark:border-neutral-800"
                  >
                    <td className="py-2 pr-3 font-medium">{r.personName}</td>
                    <td className="py-2 pr-3 text-xs text-neutral-500">
                      {formatDate(r.txnDate)} · {r.txnDescription}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs">
                      {formatPaise(r.expectedPaise)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs text-neutral-500">
                      {formatPaise(r.settledPaise)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-sm text-amber-700 dark:text-amber-400">
                      {formatPaise(r.outstandingPaise)}
                    </td>
                    <td className="py-2 pr-3 text-right text-xs text-neutral-500">
                      {r.ageDays}d
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>

      {settled.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold text-neutral-500">
            Settled ({settled.length})
          </h2>
          <ul className="mt-2 space-y-1 text-xs text-neutral-500">
            {settled.map((r) => (
              <li key={r.participantId}>
                {r.personName} · {formatPaise(r.expectedPaise)} ·{" "}
                {formatDate(r.txnDate)} · {r.txnDescription}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
