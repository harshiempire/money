import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "./index";
import { extractCounterparty } from "@/domain/categorize/counterparty";

export async function backfillCounterparties(
  accountIds: string[],
  userId: string,
) {
  if (accountIds.length === 0) return { linked: 0, created: 0 };

  const [{ pending }] = await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(schema.transactions)
    .where(
      and(
        inArray(schema.transactions.accountId, accountIds),
        isNull(schema.transactions.counterpartyId),
      ),
    );
  if (pending === 0) return { linked: 0, created: 0 };

  const rows = await db
    .select({
      id: schema.transactions.id,
      channel: schema.transactions.channel,
      raw: schema.transactions.rawDescription,
    })
    .from(schema.transactions)
    .where(
      and(
        inArray(schema.transactions.accountId, accountIds),
        isNull(schema.transactions.counterpartyId),
      ),
    );

  const existing = await db
    .select({
      id: schema.counterparties.id,
      key: schema.counterparties.key,
    })
    .from(schema.counterparties)
    .where(eq(schema.counterparties.userId, userId));
  const byKey = new Map(existing.map((r) => [r.key, r.id]));

  let created = 0;
  let linked = 0;

  for (const row of rows) {
    const cp = extractCounterparty(row.raw, row.channel);
    if (!cp) continue;
    let id = byKey.get(cp.key);
    if (!id) {
      const [inserted] = await db
        .insert(schema.counterparties)
        .values({
          userId,
          kind: cp.kind,
          key: cp.key,
          displayName: cp.displayName,
        })
        .onConflictDoNothing({
          target: [schema.counterparties.userId, schema.counterparties.key],
        })
        .returning({ id: schema.counterparties.id });
      if (inserted) {
        id = inserted.id;
        byKey.set(cp.key, id);
        created++;
      } else {
        const [found] = await db
          .select({ id: schema.counterparties.id })
          .from(schema.counterparties)
          .where(
            and(
              eq(schema.counterparties.userId, userId),
              eq(schema.counterparties.key, cp.key),
            ),
          )
          .limit(1);
        id = found?.id;
        if (id) byKey.set(cp.key, id);
      }
    }
    if (!id) continue;
    await db
      .update(schema.transactions)
      .set({ counterpartyId: id })
      .where(eq(schema.transactions.id, row.id));
    linked++;
  }

  return { linked, created };
}
