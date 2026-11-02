import "server-only";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { Schema } from "effect";
import { schema } from "@/db";
import { getOrCreatePerson } from "@/db/person";
import { throwForbidden } from "@/lib/auth/forbidden";
import { LedgerError, type WriteContext } from "./context";
import { RowOperation, snapshotDiff, orderRowOperations } from "./rules";
import { runChange, type LedgerTx } from "./store";

import type { Snapshot } from "./rules";
export type { Snapshot } from "./rules";
const key = (target: string, id: string) => `${target}:${id}`;
/**
 * Coarse user lock serializes relational writes, including absent rows and new
 * person names. Row locks are then taken table-by-table, in id order. This is
 * deliberately conservative for a personal ledger; field edits use the same
 * transaction locks. Never call the global-db outstanding helpers inside here.
 */
export async function lockRelationalActor(tx: LedgerTx, ctx: WriteContext) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${"ledger-relations:" + ctx.actor.userId}, 0))`,
  );
}
export function relationalSnapshot(tx: LedgerTx, ctx: WriteContext, lock: true): Promise<Snapshot>;
export function relationalSnapshot(tx: Pick<LedgerTx, "execute">, ctx: WriteContext, lock?: false): Promise<Snapshot>;
export async function relationalSnapshot(tx: Pick<LedgerTx, "execute">, ctx: WriteContext, lock = false): Promise<Snapshot> {
  const t = schema.transactions,
    p = schema.persons,
    s = schema.splits,
    sp = schema.splitParticipants,
    o = schema.owedExpenses,
    n = schema.netEvents,
    st = schema.settlements;
  // Materialize each table once and force the preceding lock set to finish
  // before acquiring the next. One statement avoids a round trip per table
  // (postgres.js cannot pipeline these parameterized reads with prepare:false).
  const tables = [
    { name: "ledger_txns", table: t, scope: eq(t.accountId, ctx.actor.accountId) },
    { name: "ledger_categories", table: schema.categories, scope: eq(schema.categories.userId, ctx.actor.userId) },
    { name: "ledger_people", table: p, scope: eq(p.userId, ctx.actor.userId) },
    { name: "ledger_splits", table: s, scope: sql`${s.transactionId} in (select id from ledger_txns)` },
    { name: "ledger_shares", table: sp, scope: sql`${sp.splitId} in (select id from ledger_splits)` },
    { name: "ledger_owed", table: o, scope: eq(o.userId, ctx.actor.userId) },
    { name: "ledger_net", table: n, scope: eq(n.userId, ctx.actor.userId) },
    { name: "ledger_settlements", table: st, scope: sql`(
      ${st.splitParticipantId} in (select id from ledger_shares)
      or ${st.owedExpenseId} in (select id from ledger_owed)
      or ${st.netEventId} in (select id from ledger_net)
      or ${st.inflowTransactionId} in (select id from ledger_txns)
    )` },
  ];
  const ctes = tables.map(({ name, table, scope }, index) => sql`
    ${sql.identifier(name)} as materialized (
      select * from ${table}
      where ${scope}
      ${lock && index > 0 ? sql`and (select count(*) from ${sql.identifier(tables[index - 1].name)}) >= 0` : sql``}
      order by ${getTableColumns(table).id}
      ${lock ? (table === schema.categories ? sql`for key share` : sql`for update`) : sql``}
    )
  `);
  const jsonRows = (name: string, columns: Record<string, { name: string }>) => {
    const fields = Object.entries(columns).flatMap(([field, column]) => [
      sql`${field}::text`,
      field === "createdAt" ? sql`${sql.identifier(column.name)}::text` : sql`${sql.identifier(column.name)}`,
    ]);
    return sql`(select coalesce(jsonb_agg(jsonb_build_object(${sql.join(fields, sql`, `)}) order by id), '[]'::jsonb) from ${sql.identifier(name)})`;
  };
  type TimestampRows<T> = Array<Omit<T, "createdAt"> & { createdAt: string }>;
  const [data] = await tx.execute<{
    transactions: Array<Pick<typeof t.$inferSelect, "id" | "residualDisposition" | "residualAcknowledgedPaise">>;
    persons: TimestampRows<typeof p.$inferSelect>;
    splits: TimestampRows<typeof s.$inferSelect>;
    participants: Array<typeof sp.$inferSelect>;
    owed: TimestampRows<typeof o.$inferSelect>;
    net: TimestampRows<typeof n.$inferSelect>;
    settlements: TimestampRows<typeof st.$inferSelect>;
    personUses: Array<Pick<typeof sp.$inferSelect, "id" | "personId">>;
  }>(sql`
    with ${sql.join(ctes, sql`, `)},
    ledger_person_uses as materialized (
      select ${sp.id}, ${sp.personId} from ${sp}
      where ${sp.personId} in (select id from ledger_people)
    )
    select
      ${jsonRows("ledger_txns", { id: t.id, residualDisposition: t.residualDisposition, residualAcknowledgedPaise: t.residualAcknowledgedPaise })} as transactions,
      ${jsonRows("ledger_people", getTableColumns(p))} as persons,
      ${jsonRows("ledger_splits", getTableColumns(s))} as splits,
      ${jsonRows("ledger_shares", getTableColumns(sp))} as participants,
      ${jsonRows("ledger_owed", getTableColumns(o))} as owed,
      ${jsonRows("ledger_net", getTableColumns(n))} as net,
      ${jsonRows("ledger_settlements", getTableColumns(st))} as settlements,
      ${jsonRows("ledger_person_uses", { id: sp.id, personId: sp.personId })} as "personUses"
  `);
  const { transactions, persons, splits, participants, owed, net, settlements, personUses } = data;
  const result: Snapshot = new Map();
  const add = (
    target: RowOperation["target"],
    rows: Array<{ id: string }>,
    dependents: (id: string) => string[] = () => [],
  ) => {
    for (const { id, ...row } of rows) {
      const state = { row, dependents: dependents(id).sort() };
      result.set(
        key(target, id),
        Schema.decodeUnknownSync(RowOperation)({
          target,
          id,
          before: state,
          after: state,
        }),
      );
    }
  };
  add(
    "transaction_residual",
    transactions.map((r) => ({
      id: r.id,
      residualDisposition: r.residualDisposition,
      residualAcknowledgedPaise: r.residualAcknowledgedPaise,
    })),
    (id) => [
      ...splits.filter((r) => r.transactionId === id).map((r) => key("split", r.id)),
      ...settlements.filter((r) => r.inflowTransactionId === id).map((r) => key("settlement", r.id)),
      ...owed.filter((r) => r.sourceInflowTransactionId === id).map((r) => key("owed_expense", r.id)),
      ...net
        .filter((r) => r.inflowTransactionId === id || r.outflowTransactionId === id)
        .map((r) => key("net_event", r.id)),
    ],
  );
  add("person", persons, (id) => [
    ...personUses.filter((r) => r.personId === id).map((r) => key("participant", r.id)),
    ...owed.filter((r) => r.personId === id).map((r) => key("owed_expense", r.id)),
  ]);
  add("split", splits, (id) =>
    participants.filter((r) => r.splitId === id).map((r) => key("participant", r.id)),
  );
  add("participant", participants, (id) =>
    settlements.filter((r) => r.splitParticipantId === id).map((r) => key("settlement", r.id)),
  );
  add("owed_expense", owed, (id) =>
    settlements.filter((r) => r.owedExpenseId === id).map((r) => key("settlement", r.id)),
  );
  add("net_event", net, (id) =>
    settlements.filter((r) => r.netEventId === id).map((r) => key("settlement", r.id)),
  );
  add("settlement", settlements);
  return result;
}
export function relationalHelpers(tx: LedgerTx, ctx: WriteContext, snapshot: Snapshot) {
  const operations = [...snapshot.values()];
  // These are the locked pre-write rows, not a cache of subsequent mutations.
  const before = {
    splits: operations.flatMap(op => op.target === "split" && op.after ? [{ id: op.id, ...op.after.row }] : []),
    participants: operations.flatMap(op => op.target === "participant" && op.after ? [{ id: op.id, ...op.after.row }] : []),
    settlements: operations.flatMap(op => op.target === "settlement" && op.after ? [{ id: op.id, ...op.after.row }] : []),
    owed: operations.flatMap(op => op.target === "owed_expense" && op.after ? [{ id: op.id, ...op.after.row }] : []),
    people: operations.flatMap(op => op.target === "person" && op.after ? [{ id: op.id, ...op.after.row }] : []),
  };
  const owned = (target: RowOperation["target"], id: string) => {
    if (!snapshot.has(key(target, id))) throwForbidden();
  };
  const settled = async (
    field: "splitParticipantId" | "owedExpenseId",
    ids: string[],
    excludeNetEventId?: string,
  ) => {
    const selected = new Set(ids);
    const rows = before.settlements.filter(row => {
      const id = row[field];
      return id !== null && selected.has(id);
    });
    const sums = new Map<string, number>();
    for (const r of rows) {
      const id = r[field];
      if (id && (!excludeNetEventId || r.netEventId !== excludeNetEventId))
        sums.set(id, (sums.get(id) ?? 0) + Number(r.amountPaise));
    }
    return sums;
  };
  return {
    before,
    assertTransactionOwned: async (_userId: string, id: string) => owned("transaction_residual", id),
    assertSplitParticipantOwned: async (_userId: string, id: string) => owned("participant", id),
    assertOwedExpenseOwned: async (_userId: string, id: string) => owned("owed_expense", id),
    assertSettlementOwned: async (_userId: string, id: string) => owned("settlement", id),
    assertNetEventOwned: async (_userId: string, id: string) => owned("net_event", id),
    assertCategoryOwned: async (_userId: string, id: string) => {
      const [row] = await tx
        .select()
        .from(schema.categories)
        .where(and(eq(schema.categories.id, id), eq(schema.categories.userId, ctx.actor.userId)))
        .for("key share");
      if (!row) throwForbidden();
    },
    getOrCreatePerson: (_userId: string, name: string, _client?: LedgerTx) => {
      // Exact matches need no query. Leave case folding and new names to the
      // existing Postgres helper so its locale/uniqueness behavior is retained.
      const existing = before.people.find(person => person.name === name.trim());
      return existing ? Promise.resolve(existing.id) : getOrCreatePerson(ctx.actor.userId, name, tx);
    },
    settledAmountByParticipantIds: (ids: string[], exclude?: string) =>
      settled("splitParticipantId", ids, exclude),
    settledAmountByOwedExpenseIds: (ids: string[], exclude?: string) =>
      settled("owedExpenseId", ids, exclude),
    participantOutstanding: async (id: string, exclude?: string) => {
      owned("participant", id);
      const r = before.participants.find(row => row.id === id)!;
      return Math.max(
        0,
        Number(r.expectedAmountPaise) - ((await settled("splitParticipantId", [id], exclude)).get(id) ?? 0),
      );
    },
    owedExpenseOutstanding: async (id: string, exclude?: string) => {
      owned("owed_expense", id);
      const r = before.owed.find(row => row.id === id)!;
      return Math.max(
        0,
        Number(r.amountPaise) - ((await settled("owedExpenseId", [id], exclude)).get(id) ?? 0),
      );
    },
  };
}
export type RelationalHelpers = ReturnType<typeof relationalHelpers>;
export async function runRelationalChange<R extends { revalidate: boolean }>(
  ctx: WriteContext,
  kind: string,
  work: (tx: LedgerTx, helpers: RelationalHelpers) => Promise<R>,
) {
  if (ctx.source === "mcp" && (!ctx.idempotency || !/^[A-Za-z0-9_-]{8,80}$/.test(ctx.idempotency.key)))
    throw new LedgerError({
      code: "invalid_input",
      message: "Use an 8–80 character idempotency key.",
    });
  // The authenticated door hashes the external request before resolving refs.
  // Keep that hash intact so replayChange can replay even deleted/changed refs.
  return runChange<R & { changeId: string | null }>(ctx, { kind }, async (tx) => {
    await lockRelationalActor(tx, ctx);
    const before = await relationalSnapshot(tx, ctx, true);
    const value = await work(tx, relationalHelpers(tx, ctx, before));
    const ops = snapshotDiff(before, await relationalSnapshot(tx, ctx));
    return { ops, result: { ...value, changeId: null } };
  });
}

/** All stale checks happen before this function. Deletes precede parents;
 * inserts precede children. Updates retain ids and never invoke cascades. */
export async function applyRowOperations(tx: LedgerTx, ops: RowOperation[]) {
  const { deletes, upserts } = orderRowOperations(ops);
  for (const op of deletes) {
    if (op.after !== null) continue;
    switch (op.target) {
      case "settlement":
        await tx.delete(schema.settlements).where(eq(schema.settlements.id, op.id));
        break;
      case "participant":
        await tx.delete(schema.splitParticipants).where(eq(schema.splitParticipants.id, op.id));
        break;
      case "split":
        await tx.delete(schema.splits).where(eq(schema.splits.id, op.id));
        break;
      case "owed_expense":
        await tx.delete(schema.owedExpenses).where(eq(schema.owedExpenses.id, op.id));
        break;
      case "net_event":
        await tx.delete(schema.netEvents).where(eq(schema.netEvents.id, op.id));
        break;
      case "person":
        await tx.delete(schema.persons).where(eq(schema.persons.id, op.id));
        break;
      case "transaction_residual":
        throw new Error("Bank transactions cannot be deleted by ledger undo.");
    }
  }
  for (const op of upserts) {
    if (!op.after) continue;
    // Timestamp text retains PostgreSQL's sub-millisecond precision.
    switch (op.target) {
      case "transaction_residual":
        await tx.update(schema.transactions).set(op.after.row).where(eq(schema.transactions.id, op.id));
        break;
      case "participant": {
        const values = op.after.row;
        if (op.before)
          await tx.update(schema.splitParticipants).set(values).where(eq(schema.splitParticipants.id, op.id));
        else await tx.insert(schema.splitParticipants).values({ id: op.id, ...values });
        break;
      }
      case "split": {
        const values = {
          ...op.after.row,
          createdAt: sql`${op.after.row.createdAt}::timestamptz`,
        };
        if (op.before) await tx.update(schema.splits).set(values).where(eq(schema.splits.id, op.id));
        else await tx.insert(schema.splits).values({ id: op.id, ...values });
        break;
      }
      case "person": {
        const values = {
          ...op.after.row,
          createdAt: sql`${op.after.row.createdAt}::timestamptz`,
        };
        if (op.before) await tx.update(schema.persons).set(values).where(eq(schema.persons.id, op.id));
        else await tx.insert(schema.persons).values({ id: op.id, ...values });
        break;
      }
      case "settlement": {
        const values = {
          ...op.after.row,
          createdAt: sql`${op.after.row.createdAt}::timestamptz`,
        };
        if (op.before)
          await tx.update(schema.settlements).set(values).where(eq(schema.settlements.id, op.id));
        else await tx.insert(schema.settlements).values({ id: op.id, ...values });
        break;
      }
      case "net_event": {
        const values = {
          ...op.after.row,
          createdAt: sql`${op.after.row.createdAt}::timestamptz`,
        };
        if (op.before) await tx.update(schema.netEvents).set(values).where(eq(schema.netEvents.id, op.id));
        else await tx.insert(schema.netEvents).values({ id: op.id, ...values });
        break;
      }
      case "owed_expense": {
        const values = {
          ...op.after.row,
          createdAt: sql`${op.after.row.createdAt}::timestamptz`,
        };
        if (op.before)
          await tx.update(schema.owedExpenses).set(values).where(eq(schema.owedExpenses.id, op.id));
        else await tx.insert(schema.owedExpenses).values({ id: op.id, ...values });
        break;
      }
    }
  }
}
