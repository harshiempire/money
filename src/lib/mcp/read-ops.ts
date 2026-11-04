import { loadBalances } from "@/lib/ledger/read/balances";
import { runLedger } from "@/lib/ledger/run";
import { rupees } from "./view";
import "server-only";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema } from "@/db";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
import { readStandingNotes } from "@/lib/assistant/actor-ops";
import { loadCategories } from "@/lib/assistant/data";
import { categoryBreakdown, loadPeriodTxnMetrics } from "@/domain/spend/net";
import { storeProposedDraft } from "./draft-store";
import type { McpOps } from "./server";
import { counterpartyLabel } from "@/lib/format";
import { uncategorizedCondition } from "@/domain/spend/uncategorized";
import { resolveMcpPeriod } from "./range";
import { buildOverview } from "./overview";
import { loadMcpSummary } from "./summary";
import { McpToolError } from "./pagination";
import type { PeriodInput } from "./schemas";
import { loadMcpReadModel } from "./model-read-ops";

const t = schema.transactions;
const defaultCategory = alias(schema.categories, "payee_default_category");
const account = schema.moneyAccounts;
const ownsAccount = (actor: MoneyActor) =>
  and(eq(account.id, actor.accountId), eq(account.userId, actor.userId));

const txnRange = (period: { from: string | null; to: string | null }) => [
  period.from ? gte(t.txnDate, period.from) : undefined,
  period.to ? lte(t.txnDate, period.to) : undefined,
];

async function loadOpenShares(actor: MoneyActor, input: PeriodInput) {
  const bounds = resolveMcpPeriod(input);
  return (await runLedger(loadBalances(),actor)).flatMap(p => p.shares.filter(s => (!bounds.from || s.date >= bounds.from) && (!bounds.to || s.date <= bounds.to)).map(s => ({ txnDate:s.date,personName:p.name,outstandingPaise:s.leftPaise })));

}

export const mcpReadOps: McpOps = {
  readModel: (actor) => loadMcpReadModel(actor, () => mcpReadOps.listTransactions(actor, {})),
  listCategories: (actor) => loadCategories(actor.userId),
  async listTransactions(actor, input) {
    const bounds = resolveMcpPeriod(input);
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
        defaultCategory: defaultCategory.name,
        person: schema.persons.name,
        isTransfer: t.isTransfer,
        needsReview: t.needsReview,
        categoryId: t.categoryId,
        residualDisposition: t.residualDisposition,
        residualAcknowledgedPaise: t.residualAcknowledgedPaise,
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
      .leftJoin(schema.persons, and(eq(schema.counterparties.personId, schema.persons.id), eq(schema.persons.userId, actor.userId)))
      .leftJoin(defaultCategory, and(eq(schema.counterparties.defaultCategoryId, defaultCategory.id), eq(defaultCategory.userId, actor.userId)))
      .where(
        and(
          eq(t.accountId, actor.accountId),
          ...txnRange(bounds),
          input.uncategorized ? uncategorizedCondition(t.categoryId) : undefined,
          input.direction ? eq(t.drCr, input.direction === "paid" ? "debit" : "credit") : undefined,
          input.category !== undefined ? eq(schema.categories.name, input.category) : undefined,
        ),
      );
    return rows.map((row) => ({ ...row, label: counterpartyLabel(row.rawDescription) }));
  },
  async overview(actor) {
    const [transactions, balances] = await Promise.all([
      db.select({
        txnDate: t.txnDate,
        amountPaise: t.amountPaise,
        drCr: t.drCr,
        categoryId: t.categoryId,
        hasSplit: sql<boolean>`exists (select 1 from ${schema.splits} where ${schema.splits.transactionId} = ${t.id})`,
      }).from(t)
        .innerJoin(account, and(eq(t.accountId, account.id), ownsAccount(actor)))
        .where(eq(t.accountId, actor.accountId)),
      runLedger(loadBalances(),actor),
    ]);
    const result = buildOverview(transactions, balances.flatMap(p => p.shares.map(s => ({txnDate:s.date,personName:p.name,outstandingPaise:s.leftPaise}))), []);
    const people = balances.filter(p => p.openShareCount || p.openOwedCount)
      .sort((a,b) => (b.owedToYouPaise+b.youOwePaise)-(a.owedToYouPaise+a.youOwePaise) || a.name.localeCompare(b.name))
      .map(p => ({name:p.name,owed_to_you:rupees(p.owedToYouPaise),you_owe:rupees(p.youOwePaise)}));
    return { ...result, people };
  },
  async periodSummary(actor, input) {
    // Domain spend loaders take trusted ids; verify the account/user pair before calling them.
    const [owned] = await db.select({ id: account.id }).from(account).where(ownsAccount(actor)).limit(1);
    if (!owned) throw new McpToolError("That account isn't available.");
    return loadMcpSummary(actor, input, {
      metrics: loadPeriodTxnMetrics,
      categories: categoryBreakdown,
      openShares: loadOpenShares,
    });
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
