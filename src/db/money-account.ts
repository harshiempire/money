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

  const [created] = await db
    .insert(schema.moneyAccounts)
    .values({
      userId,
      bank,
      name: "BoB SBA",
      openingBalancePaise: 0,
      openingDate: new Date().toISOString().slice(0, 10),
    })
    .returning();
  return created;
}
