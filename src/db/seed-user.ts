import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "./index";

// Single-user app: until Auth.js is wired up, every server action operates as
// this deterministic seeded user. Replace with `auth()` from Auth.js later.
export const SEED_USER_ID = "00000000-0000-0000-0000-000000000001";
const SEED_EMAIL = "owner@local";

export async function ensureSeedUser() {
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, SEED_USER_ID))
    .limit(1);
  if (existing.length === 0) {
    await db
      .insert(schema.users)
      .values({ id: SEED_USER_ID, email: SEED_EMAIL })
      .onConflictDoNothing();
  }
  return SEED_USER_ID;
}
