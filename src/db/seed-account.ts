import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "./index";
import { ensureSeedUser } from "./seed-user";

/**
 * Single-user MVP: ensure there's a BoB account to import into. The opening
 * balance is taken from the first row of the user's real statement so the
 * running-balance derivation matches the bank's view.
 */
export async function ensureDefaultBobAccount() {
  const userId = await ensureSeedUser();

  const existing = await db
    .select()
    .from(schema.moneyAccounts)
    .where(
      and(
        eq(schema.moneyAccounts.userId, userId),
        eq(schema.moneyAccounts.bank, "bob"),
      ),
    )
    .limit(1);

  if (existing[0]) return existing[0];

  const [created] = await db
    .insert(schema.moneyAccounts)
    .values({
      userId,
      name: "BoB SBA",
      bank: "bob",
      // Real opening balance from the Mar-Apr 2026 statement: ₹2,367.84.
      // The Opening Balance row in the PDF will overwrite this if needed.
      openingBalancePaise: 236784,
      openingDate: "2026-03-01",
    })
    .returning();
  return created;
}
