import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCurrentUser } from "@/lib/auth/require-current-user";
import { counterpartyLabel, formatDate, formatPaise } from "@/lib/format";
import { getPersonDetail } from "@/lib/people/ledger";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGrid } from "@/components/ui/Stat";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Money } from "@/components/ui/Money";

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
    <>
      <PageHeader title={detail.personName}>
        <Link href="/people">
          <Button variant="outline" size="sm">← All people</Button>
        </Link>
      </PageHeader>

      <StatGrid>
        <Stat
          label="They owe me"
          value={formatPaise(detail.receivableOutstandingPaise)}
          tone="warning"
        />
        <Stat
          label="I owe them"
          value={formatPaise(detail.payableOutstandingPaise)}
          tone="neutral"
        />
        <Stat
          label="Net"
          value={`${formatPaise(Math.abs(detail.netPaise))}${detail.netPaise < 0 ? " (you owe)" : ""}`}
          tone={detail.netPaise >= 0 ? "warning" : "neutral"}
        />
      </StatGrid>

      {detail.receivables.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="Open receivables" />
          <ul className="mt-4 space-y-2 text-sm">
            {detail.receivables.map((r) => (
              <li
                key={r.participantId}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-overlay)]/30 p-3"
              >
                <span>
                  {formatDate(r.txnDate)} · {counterpartyLabel(r.txnDescription)}
                </span>
                <Money paise={r.outstandingPaise} size="sm" className="text-[var(--color-warning)]" />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {detail.payables.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="Open payables" />
          <ul className="mt-4 space-y-2 text-sm">
            {detail.payables.map((p) => (
              <li
                key={p.owedExpenseId}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-overlay)]/30 p-3"
              >
                <span>
                  {formatDate(p.incurredDate)} · {p.description}
                  {p.categoryName && (
                    <span className="ml-1 text-xs text-[var(--color-text-muted)]">
                      ({p.categoryName})
                    </span>
                  )}
                </span>
                <Money paise={p.outstandingPaise} size="sm" className="text-[var(--color-info)]" />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {detail.netEvents.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="Net settle history" />
          <ul className="mt-4 space-y-2 text-sm">
            {detail.netEvents.map((e) => (
              <li
                key={e.netEventId}
                className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
              >
                <div className="font-medium">
                  {formatDate(e.eventDate)} · Net settled
                </div>
                <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                  Receivable {formatPaise(e.receivablePaise)} · Payable{" "}
                  {formatPaise(e.payablePaise)}
                  {e.bankDeltaPaise !== 0 &&
                    ` · Bank delta ${formatPaise(Math.abs(e.bankDeltaPaise))}`}
                </div>
                {e.note && (
                  <div className="mt-1 text-xs italic text-[var(--color-text-muted)]">
                    {e.note}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
