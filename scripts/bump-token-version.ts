/**
 * Invalidate all JWT sessions for a user (e.g. after password change).
 *
 * Usage: USER_ID=... bun run scripts/bump-token-version.ts
 */
import { eq } from "drizzle-orm";
import { db, schema } from "./lib/db";

const userId = process.env.USER_ID?.trim();
if (!userId) {
  console.error("Set USER_ID");
  process.exit(1);
}

const [row] = await db
  .select({ tokenVersion: schema.users.tokenVersion })
  .from(schema.users)
  .where(eq(schema.users.id, userId))
  .limit(1);
if (!row) {
  console.error("User not found");
  process.exit(1);
}

await db
  .update(schema.users)
  .set({ tokenVersion: row.tokenVersion + 1 })
  .where(eq(schema.users.id, userId));

console.log(`Bumped token_version for ${userId}`);
