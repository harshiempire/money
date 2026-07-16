import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "./index";

export type BankCode = "bob";

export async function getOrCreateAccountForBank(userId: string, bank: BankCode) {
  const existing = await db
    .select()
    .from(schema.moneyAccounts)
    .where(
      and(
        eq(schema.moneyAccounts.userId, userId),
        eq(schema.moneyAccounts.bank, bank),
      ),
    )
    .limit(1);

  if (existing[0]) return existing[0];

  // Concurrent first requests can race this insert; the unique index on
  // (user_id, bank) makes the loser no-op, so re-select the winner's row.
  const [created] = await db
    .insert(schema.moneyAccounts)
    .values({
      userId,
      bank,
      name: "BoB SBA",
      openingBalancePaise: 0,
      openingDate: new Date().toISOString().slice(0, 10),
    })
    .onConflictDoNothing({
      target: [schema.moneyAccounts.userId, schema.moneyAccounts.bank],
    })
    .returning();
  if (created) return created;

  const [winner] = await db
    .select()
    .from(schema.moneyAccounts)
    .where(
      and(
        eq(schema.moneyAccounts.userId, userId),
        eq(schema.moneyAccounts.bank, bank),
      ),
    )
    .limit(1);
  if (!winner) {
    throw new Error(`money_account for ${bank} disappeared after insert race`);
  }
  return winner;
}
