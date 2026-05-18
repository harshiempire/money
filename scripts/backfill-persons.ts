/**
 * Link existing split_participant rows to person rows (case-insensitive name per user).
 * Idempotent: skips participants that already have person_id.
 *
 * Usage: bun run scripts/backfill-persons.ts
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "./lib/db";

const PG_UNIQUE_VIOLATION = "23505";

try {
  await db
    .select({ personId: schema.splitParticipants.personId })
    .from(schema.splitParticipants)
    .limit(1);
} catch (err) {
  const code =
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
      ? (err as { code: string }).code
      : null;
  if (code === "42703") {
    console.error(
      "Missing person schema — run migrations first:\n  bun run db:migrate",
    );
    process.exit(1);
  }
  throw err;
}

async function getOrCreatePerson(
  userId: string,
  name: string,
): Promise<string> {
  const trimmed = name.trim();
  const [existing] = await db
    .select({ id: schema.persons.id })
    .from(schema.persons)
    .where(
      and(
        eq(schema.persons.userId, userId),
        sql`lower(${schema.persons.name}) = lower(${trimmed})`,
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  try {
    const [created] = await db
      .insert(schema.persons)
      .values({ userId, name: trimmed })
      .returning({ id: schema.persons.id });
    return created.id;
  } catch (err) {
    const code =
      err &&
      typeof err === "object" &&
      "code" in err &&
      typeof (err as { code: unknown }).code === "string"
        ? (err as { code: string }).code
        : null;
    if (code !== PG_UNIQUE_VIOLATION) throw err;
    const [row] = await db
      .select({ id: schema.persons.id })
      .from(schema.persons)
      .where(
        and(
          eq(schema.persons.userId, userId),
          sql`lower(${schema.persons.name}) = lower(${trimmed})`,
        ),
      )
      .limit(1);
    if (!row) throw err;
    return row.id;
  }
}

const groups = await db
  .select({
    userId: schema.moneyAccounts.userId,
    displayName: sql<string>`min(${schema.splitParticipants.personName})`,
    lowerName: sql<string>`lower(${schema.splitParticipants.personName})`,
  })
  .from(schema.splitParticipants)
  .innerJoin(schema.splits, eq(schema.splitParticipants.splitId, schema.splits.id))
  .innerJoin(
    schema.transactions,
    eq(schema.splits.transactionId, schema.transactions.id),
  )
  .innerJoin(
    schema.moneyAccounts,
    eq(schema.transactions.accountId, schema.moneyAccounts.id),
  )
  .where(isNull(schema.splitParticipants.personId))
  .groupBy(
    schema.moneyAccounts.userId,
    sql`lower(${schema.splitParticipants.personName})`,
  );

let participantsUpdated = 0;

for (const g of groups) {
  const displayName = g.displayName?.trim();
  if (!displayName) continue;

  const personId = await getOrCreatePerson(g.userId, displayName);

  const userSplitIds = await db
    .select({ id: schema.splits.id })
    .from(schema.splits)
    .innerJoin(
      schema.transactions,
      eq(schema.splits.transactionId, schema.transactions.id),
    )
    .innerJoin(
      schema.moneyAccounts,
      eq(schema.transactions.accountId, schema.moneyAccounts.id),
    )
    .where(eq(schema.moneyAccounts.userId, g.userId));

  const splitIds = userSplitIds.map((s) => s.id);
  if (splitIds.length === 0) continue;

  const updated = await db
    .update(schema.splitParticipants)
    .set({ personId })
    .where(
      and(
        isNull(schema.splitParticipants.personId),
        inArray(schema.splitParticipants.splitId, splitIds),
        sql`lower(${schema.splitParticipants.personName}) = ${g.lowerName}`,
      ),
    )
    .returning({ id: schema.splitParticipants.id });

  participantsUpdated += updated.length;
}

console.log(
  `Backfill complete: ${groups.length} name group(s), ${participantsUpdated} participant row(s) updated.`,
);
