import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/request-tenant";
import { AppShell } from "@/components/AppShell";
import { counterpartyLabel, formatDate, formatPaise } from "@/lib/format";
import {
  getPersonDetail,
  type PersonPayableRow,
  type PersonReceivableRow,
} from "@/lib/people/ledger";
import { transactionHref } from "@/lib/transactions/href";
import { CopyBalanceSummary } from "./CopyBalanceSummary";

export const dynamic = "force-dynamic";

export default async function PersonDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  const detail = await getPersonDetail(user.id, id);
  if (!detail) notFound();
  const balanceSummary = buildBalanceSummary(detail);

  return (
    <AppShell title={detail.personName}>
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

      <CopyBalanceSummary summary={balanceSummary} />

      {detail.receivables.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Open receivables</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {detail.receivables.map((r) => (
              <li
                key={r.participantId}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded border border-neutral-200 p-2 dark:border-neutral-800"
              >
                <span className="min-w-0">
                  <span className="block">
                    {formatDate(r.txnDate)} ·{" "}
                    {r.counterpartyDisplayName ??
                      counterpartyLabel(r.txnDescription)}{" "}
                    <a
                      href={transactionHref(r.txnId)}
                      className="text-xs text-neutral-500 underline-offset-2 hover:underline"
                    >
                      View transaction →
                    </a>
                  </span>
                  {(r.parsedPurpose || r.txnNote) && (
                    <span className="mt-0.5 block text-xs italic text-neutral-500">
                      {[r.parsedPurpose, r.txnNote]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                </span>
                <span className="font-mono text-xs text-owed-to-me">
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
                <span className="font-mono text-xs text-i-owe">
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
    </AppShell>
  );
}

function buildBalanceSummary(detail: {
  personName: string;
  receivables: PersonReceivableRow[];
  payables: PersonPayableRow[];
  receivableOutstandingPaise: number;
  payableOutstandingPaise: number;
  netPaise: number;
}): string {
  const lines = [`Balance summary for ${detail.personName}`, "", "They owe me:"];

  if (detail.receivables.length === 0) {
    lines.push("- None");
  } else {
    for (const r of detail.receivables) {
      const label =
        r.counterpartyDisplayName ?? counterpartyLabel(r.txnDescription);
      const detailLabel = [r.parsedPurpose, r.txnNote]
        .filter(Boolean)
        .join(" · ");
      lines.push(
        `- ${formatDate(r.txnDate)} · ${label}${detailLabel ? ` · ${detailLabel}` : ""} — ${formatPaise(r.outstandingPaise)}`,
      );
    }
  }

  lines.push("", "I owe them:");
  if (detail.payables.length === 0) {
    lines.push("- None");
  } else {
    for (const p of detail.payables) {
      lines.push(
        `- ${formatDate(p.incurredDate)} · ${p.description}${p.categoryName ? ` (${p.categoryName})` : ""} — ${formatPaise(p.outstandingPaise)}`,
      );
    }
  }

  lines.push(
    "",
    `They owe me: ${formatPaise(detail.receivableOutstandingPaise)}`,
    `I owe them: ${formatPaise(detail.payableOutstandingPaise)}`,
    detail.netPaise === 0 &&
      detail.receivableOutstandingPaise === 0 &&
      detail.payableOutstandingPaise === 0
      ? `Net: ${formatPaise(0)} (fully settled)`
      : detail.netPaise === 0
        ? `Net: ${formatPaise(0)} (offsetting open items)`
      : detail.netPaise > 0
        ? `Net: ${formatPaise(detail.netPaise)} (they owe me)`
        : `Net: ${formatPaise(Math.abs(detail.netPaise))} (I owe them)`,
  );

  return lines.join("\n");
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs uppercase text-neutral-500">{label}</div>
      <div className="mt-1 font-mono text-lg">{value}</div>
    </div>
  );
}
