import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "./index";

/**
 * The starter category set covers the user's actual statement: groceries
 * and food delivery, transit, family P2P, Groww round-trips, etc. Idempotent —
 * skips any category that already exists for the user.
 */
const DEFAULTS: Array<{
  name: string;
  kind: (typeof schema.categoryKindEnum.enumValues)[number];
}> = [
  { name: "Food", kind: "spend" },
  { name: "Groceries", kind: "spend" },
  { name: "Travel", kind: "spend" },
  { name: "Shopping", kind: "spend" },
  { name: "Subscriptions", kind: "spend" },
  { name: "Bills", kind: "spend" },
  { name: "Entertainment", kind: "spend" },
  { name: "Other spend", kind: "spend" },
  { name: "Self transfer", kind: "transfer" },
  { name: "Family", kind: "transfer" },
  { name: "Investment", kind: "investment" },
  { name: "Reimbursement", kind: "reimbursement" },
  { name: "Income", kind: "income" },
];

export async function ensureDefaultCategories(userId: string) {
  const existing = await db
    .select({ name: schema.categories.name })
    .from(schema.categories)
    .where(eq(schema.categories.userId, userId));
  const have = new Set(existing.map((r) => r.name));
  const missing = DEFAULTS.filter((d) => !have.has(d.name));
  if (missing.length === 0) return;

  await db
    .insert(schema.categories)
    .values(missing.map((d) => ({ userId, name: d.name, kind: d.kind })));
}
