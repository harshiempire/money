import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { spendWaterfallRows } from "@/lib/spend/waterfall";

const enabled = process.env.MONEY_LEDGER_TEST_DB === "1";
if (enabled && !process.env.DATABASE_URL)
  throw new Error("MONEY_LEDGER_TEST_DB requires an explicitly supplied DATABASE_URL. Do not load .env files.");
const readUrl = (file: string | undefined) => {
  if (!file) return null;
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
};
if (enabled && process.env.DATABASE_URL !== readUrl(process.env.MONEY_LEDGER_TEST_DBURL_FILE))
  throw new Error("Ledger DB tests run only against the throwaway URL in MONEY_LEDGER_TEST_DBURL_FILE.");
if (enabled) {
  const target = new URL(process.env.DATABASE_URL!);
  if (target.hostname !== "127.0.0.1" || target.port !== "54330" || target.pathname !== "/money_test")
    throw new Error("Ledger DB tests require the authorized local money_test database.");
}

const FROM = "2026-03-01";
const TO = "2026-03-31";

describe.skipIf(!enabled)("a repayment isn't spend", () => {
  test("a net settlement's outflow counts as zero on every report, and counts again after delete", async () => {
    const { db, schema } = await import("@/db");
    const { loadPeriodTxnMetrics, categoryBreakdown } = await import("@/domain/spend/net");
    const { mapPeriodMetrics } = await import("@/domain/spend/period-metrics");
    const { reimbursementBridgeTotals } = await import("@/domain/spend/reimbursements");
    const { deleteNetEvent } = await import("./net-events");
    const { undoChange } = await import("./undo");
    const { mcpReadOps } = await import("@/lib/mcp/read-ops");
    const id = () => crypto.randomUUID();
    const actor = { userId: id(), accountId: id() };
    const stranger = id();
    const [repayment, groceries, strangerLinked, splitBill, transferBill] = [id(), id(), id(), id(), id()];
    const owed = id(), person = id(), event = id(), strangerEvent = id(), category = id();
    const [split, transferSplit, share, transferShare] = [id(), id(), id(), id()];
    const debit = (txnId: string, amountPaise: number, extra: Record<string, unknown> = {}) => ({
      id: txnId, accountId: actor.accountId, txnDate: "2026-03-10", amountPaise, drCr: "debit" as const,
      channel: "other" as const, refId: txnId, rawDescription: `test ${txnId}`, ...extra,
    });
    await db.insert(schema.users).values([
      { id: actor.userId, email: `${actor.userId}@repayment.test` },
      { id: stranger, email: `${stranger}@repayment.test` },
    ]);
    try {
      await db.insert(schema.moneyAccounts).values({ id: actor.accountId, userId: actor.userId, bank: "bob", name: "Test", openingDate: "2026-01-01", openingBalancePaise: 0 });
      await db.insert(schema.categories).values({ id: category, userId: actor.userId, name: "Food", kind: "spend" });
      await db.insert(schema.persons).values({ id: person, userId: actor.userId, name: "Kiran" });
      await db.insert(schema.transactions).values([
        debit(repayment, 20000, { categoryId: category }),
        debit(groceries, 10000, { categoryId: category }),
        debit(strangerLinked, 5000),
        debit(splitBill, 8000),
        debit(transferBill, 3000, { isTransfer: true }),
      ]);
      await db.insert(schema.splits).values([
        { id: split, transactionId: splitBill, totalPaise: 8000, yourSharePaise: 4000 },
        { id: transferSplit, transactionId: transferBill, totalPaise: 3000, yourSharePaise: 1000 },
      ]);
      await db.insert(schema.splitParticipants).values([
        { id: share, splitId: split, personId: person, personName: "Kiran", expectedAmountPaise: 4000 },
        { id: transferShare, splitId: transferSplit, personId: person, personName: "Kiran", expectedAmountPaise: 2000 },
      ]);
      await db.insert(schema.owedExpenses).values({ id: owed, userId: actor.userId, personId: person, personName: "Kiran", incurredDate: "2026-03-05", description: "Tickets", amountPaise: 20000 });
      await db.insert(schema.netEvents).values([
        { id: event, userId: actor.userId, eventDate: "2026-03-10", outflowTransactionId: repayment },
        // Another user's event must never change this user's numbers.
        { id: strangerEvent, userId: stranger, eventDate: "2026-03-10", outflowTransactionId: strangerLinked },
      ]);
      await db.insert(schema.settlements).values({ owedExpenseId: owed, netEventId: event, amountPaise: 20000, method: "bank" });

      const read = async () => {
        const metrics = await loadPeriodTxnMetrics(actor.accountId, FROM, TO, actor.userId);
        const { totals, bridge } = mapPeriodMetrics(metrics);
        const categories = await categoryBreakdown(actor.accountId, FROM, TO, actor.userId);
        return { totals, bridge, food: categories.find((c) => c.categoryName === "Food")?.netSelfPaise };
      };
      const owedPaise = 20000, groceriesPaise = 10000, strangerPaise = 5000, shareOfSplit = 4000;
      const withoutRepayment = groceriesPaise + strangerPaise + shareOfSplit + owedPaise;
      const rawDebits = 20000 + 10000 + 5000 + 8000 + 3000;

      const linked = await read();
      expect(linked.totals.netSelfPaise).toBe(withoutRepayment);
      expect(linked.totals.totalDebitPaise).toBe(rawDebits);
      expect(linked.totals.owedSelfPaise).toBe(owedPaise);
      const waterfall = spendWaterfallRows(linked.bridge, linked.totals.owedSelfPaise, linked.totals.netSelfPaise);
      expect(waterfall[3].to).toBe(waterfall[4].to);
      expect(linked.bridge.personalDebitGrossPaise).toBe(groceriesPaise + strangerPaise + 8000);
      expect(linked.bridge.yourShareDebitPaise).toBe(groceriesPaise + strangerPaise + shareOfSplit);
      expect(linked.food).toBe(groceriesPaise);

      const mcp = await mcpReadOps.periodSummary(actor, { month: "2026-03" });
      expect(mcp.totals.net_self).toBe("390.00");
      expect(mcp.totals.total_debit).toBe("460.00");
      expect(mcp.bridge.personal_debit_gross).toBe("230.00");
      expect(mcp.bridge.your_share_debit).toBe("190.00");

      const bridge = await reimbursementBridgeTotals(actor.accountId, FROM, TO, actor.userId);
      expect(bridge.spendOutstandingPaise).toBe(4000);
      expect(bridge.outstandingReimbursePaise).toBe(6000);

      const ctx = { actor, source: "app" as const };
      const removed = await deleteNetEvent(ctx, { netEventId: event });
      const afterDelete = await read();
      expect(afterDelete.totals.netSelfPaise).toBe(withoutRepayment + 20000);
      expect(afterDelete.bridge.personalDebitGrossPaise).toBe(groceriesPaise + strangerPaise + 8000 + 20000);
      expect(afterDelete.food).toBe(groceriesPaise + 20000);

      await undoChange(ctx, removed.changeId!);
      expect((await read()).totals.netSelfPaise).toBe(withoutRepayment);
    } finally {
      await db.delete(schema.netEvents).where(eq(schema.netEvents.userId, stranger));
      await db.delete(schema.transactions).where(eq(schema.transactions.accountId, actor.accountId));
      await db.delete(schema.users).where(eq(schema.users.id, actor.userId));
      await db.delete(schema.users).where(eq(schema.users.id, stranger));
    }
  }, 60000);
});
