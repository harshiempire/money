import { notFound } from "next/navigation";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { AppNav } from "@/components/AppNav";
import { counterpartyLabel, formatDate, formatPaise } from "@/lib/format";
import { getPersonDetail } from "@/lib/people/ledger";

export const dynamic = "force-dynamic";

export default async function PersonDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireCurrentUser();
  const detail = await getPersonDetail(user.id, id);
  if (!detail) notFound();

  return (
    <main className="mx-auto max-w-5xl p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">{detail.personName}</h1>
        <AppNav current="/people" />
      </header>

      <p className="mt-1 text-xs text-neutral-500">
        <a href="/people" className="underline">
          ← All people
        </a>
      </p>

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <Stat
          label="They owe me"
          value={formatPaise(detail.receivableOutstandingPaise)}
        />
        <Stat
          label="I owe them"
          value={formatPaise(detail.payableOutstandingPaise)}
        />
        <Stat
          label="Net"
          value={`${formatPaise(Math.abs(detail.netPaise))}${detail.netPaise < 0 ? " (you owe)" : ""}`}
        />
      </section>

      {detail.receivables.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Open receivables</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {detail.receivables.map((r) => (
              <li
                key={r.participantId}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded border border-neutral-200 p-2 dark:border-neutral-800"
              >
                <span>
                  {formatDate(r.txnDate)} ·{" "}
                  {counterpartyLabel(r.txnDescription)}
                </span>
                <span className="font-mono text-xs text-amber-700 dark:text-amber-400">
                  {formatPaise(r.outstandingPaise)} outstanding
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.payables.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Open payables</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {detail.payables.map((p) => (
              <li
                key={p.owedExpenseId}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded border border-neutral-200 p-2 dark:border-neutral-800"
              >
                <span>
                  {formatDate(p.incurredDate)} · {p.description}
                  {p.categoryName && (
                    <span className="ml-1 text-xs text-neutral-500">
                      ({p.categoryName})
                    </span>
                  )}
                </span>
                <span className="font-mono text-xs text-sky-700 dark:text-sky-400">
                  {formatPaise(p.outstandingPaise)} outstanding
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.netEvents.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Net settle history</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {detail.netEvents.map((e) => (
              <li
                key={e.netEventId}
                className="rounded border border-neutral-200 p-2 dark:border-neutral-800"
              >
                <div className="font-medium">
                  {formatDate(e.eventDate)} · Net settled
                </div>
                <div className="mt-1 text-xs text-neutral-500">
                  Receivable {formatPaise(e.receivablePaise)} · Payable{" "}
                  {formatPaise(e.payablePaise)}
                  {e.bankDeltaPaise !== 0 &&
                    ` · Bank delta ${formatPaise(Math.abs(e.bankDeltaPaise))}`}
                </div>
                {e.note && (
                  <div className="mt-1 text-xs italic text-neutral-500">
                    {e.note}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs uppercase text-neutral-500">{label}</div>
      <div className="mt-1 font-mono text-lg">{value}</div>
    </div>
  );
}
