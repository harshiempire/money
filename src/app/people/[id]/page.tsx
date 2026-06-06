import { notFound } from "next/navigation";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { PageShell } from "@/components/PageShell";
import { Section } from "@/components/ui/Section";
import { Stat } from "@/components/ui/Stat";
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
    <PageShell
      title={detail.personName}
      actions={
        <a
          href="/people"
          className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
        >
          ← All people
        </a>
      }
    >

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
        <Section title="Open receivables" className="mt-8">
          <ul className="space-y-2 text-sm">
            {detail.receivables.map((r) => (
              <li
                key={r.participantId}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border-subtle bg-surface-muted/50 p-3"
              >
                <span>
                  {formatDate(r.txnDate)} ·{" "}
                  {counterpartyLabel(r.txnDescription)}
                </span>
                <span className="font-mono text-xs text-receivable">
                  {formatPaise(r.outstandingPaise)} outstanding
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {detail.payables.length > 0 && (
        <Section title="Open payables" className="mt-8">
          <ul className="space-y-2 text-sm">
            {detail.payables.map((p) => (
              <li
                key={p.owedExpenseId}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border-subtle bg-surface-muted/50 p-3"
              >
                <span>
                  {formatDate(p.incurredDate)} · {p.description}
                  {p.categoryName && (
                    <span className="ml-1 text-xs text-neutral-500">
                      ({p.categoryName})
                    </span>
                  )}
                </span>
                <span className="font-mono text-xs text-payable">
                  {formatPaise(p.outstandingPaise)} outstanding
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {detail.netEvents.length > 0 && (
        <Section title="Net settle history" className="mt-8">
          <ul className="space-y-2 text-sm">
            {detail.netEvents.map((e) => (
              <li
                key={e.netEventId}
                className="rounded-md border border-border-subtle bg-surface-muted/50 p-3"
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
        </Section>
      )}
    </PageShell>
  );
}
