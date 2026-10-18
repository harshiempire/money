import "server-only";
import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { db, schema } from "@/db";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
import { readStandingNotes } from "@/lib/assistant/actor-ops";
import { loadCategories } from "@/lib/assistant/data";
import { monthBounds } from "@/lib/assistant/tag-store";
import { modelSafeText, userChosenDisplayName } from "@/lib/assistant/model-view";
import { resolveSpendPeriod } from "@/lib/spend/period";
import { categoryBreakdown, loadPeriodTxnMetrics } from "@/domain/spend/net";
import { mapPeriodMetrics } from "@/domain/spend/period-metrics";
import { storeProposedDraft } from "./draft-store";
import type { McpOps } from "./server";
import { bankPayeeLabel, rupees } from "./view";

const t = schema.transactions;
const account = schema.moneyAccounts;
const ownsAccount = (actor: MoneyActor) =>
  and(eq(account.id, actor.accountId), eq(account.userId, actor.userId));

export const mcpReadOps: McpOps = {
  listCategories: (actor) => loadCategories(actor.userId),
  async listTransactions(actor, input) {
    const bounds = input.month
      ? monthBounds(Number(input.month.slice(0, 4)), Number(input.month.slice(5, 7)))
      : null;
    const rows = await db
      .select({
        id: t.id,
        txnDate: t.txnDate,
        amountPaise: t.amountPaise,
        drCr: t.drCr,
        channel: t.channel,
        displayName: schema.counterparties.displayName,
        counterpartyKind: schema.counterparties.kind,
        counterpartyKey: schema.counterparties.key,
        parsedPurpose: t.parsedPurpose,
        rawDescription: t.rawDescription,
        note: t.note,
        category: schema.categories.name,
        isTransfer: t.isTransfer,
      })
      .from(t)
      .innerJoin(account, and(eq(t.accountId, account.id), ownsAccount(actor)))
      .leftJoin(
        schema.counterparties,
        and(eq(t.counterpartyId, schema.counterparties.id), eq(schema.counterparties.userId, actor.userId)),
      )
      .leftJoin(
        schema.categories,
        and(eq(t.categoryId, schema.categories.id), eq(schema.categories.userId, actor.userId)),
      )
      .where(
        and(
          eq(t.accountId, actor.accountId),
          bounds ? and(gte(t.txnDate, bounds.from), lt(t.txnDate, bounds.to)) : undefined,
          input.uncategorized ? isNull(t.categoryId) : undefined,
        ),
      );
    return rows.map(({ rawDescription, counterpartyKind, counterpartyKey, ...row }) => ({
      ...row,
      displayName: userChosenDisplayName({ kind: counterpartyKind, key: counterpartyKey, displayName: row.displayName }),
      label: bankPayeeLabel(rawDescription),
    }));
  },
  async periodSummary(actor, month) {
    const resolved = await resolveSpendPeriod(actor.accountId, month ? { month } : {});
    const { period } = resolved;
    const [metrics, breakdown] = await Promise.all([
      loadPeriodTxnMetrics(actor.accountId, period.from, period.to, actor.userId),
      categoryBreakdown(actor.accountId, period.from, period.to, actor.userId),
    ]);
    const { totals, bridge, triage } = mapPeriodMetrics(metrics);
    return {
      period: {
        from: period.from,
        to: period.to,
        label: period.label,
        partial: resolved.isPartial,
      },
      totals: {
        total_debit: rupees(totals.totalDebitPaise),
        total_credit: rupees(totals.totalCreditPaise),
        net_self: rupees(totals.netSelfPaise),
        owed_self: rupees(totals.owedSelfPaise),
        count: totals.count,
      },
      bridge: {
        personal_debit_gross: rupees(bridge.personalDebitGrossPaise),
        your_share_debit: rupees(bridge.yourShareDebitPaise),
        others_share: rupees(bridge.othersSharePaise),
        net_credit: rupees(bridge.netCreditPaise),
        split_txn_count: bridge.splitTxnCount,
      },
      triage: {
        uncategorized_net_self: rupees(triage.uncategorizedNetSelfPaise),
        uncategorized_count: triage.uncategorizedCount,
        needs_review_count: triage.needsReviewCount,
      },
      categories: breakdown.map((c) => ({
        category: modelSafeText(c.categoryName, c.categoryName.length) ?? "Category omitted",
        net: rupees(c.netSelfPaise),
        count: c.count,
      })),
    };
  },
  async standingNotes(actor) {
    return (await readStandingNotes(actor)).map((n) => n.body);
  },
  async transactionIds(actor) {
    const rows = await db
      .select({ id: t.id })
      .from(t)
      .innerJoin(account, and(eq(t.accountId, account.id), ownsAccount(actor)))
      .where(eq(t.accountId, actor.accountId));
    return rows.map((r) => r.id);
  },
  async proposalTransactions(actor, ids) {
    if (!ids.length) return [];
    return db
      .select({
        id: t.id,
        categoryId: t.categoryId,
      })
      .from(t)
      .innerJoin(account, and(eq(t.accountId, account.id), ownsAccount(actor)))
      .where(and(eq(t.accountId, actor.accountId), inArray(t.id, ids)));
  },
  storeDraft: storeProposedDraft,
};
