/**
 * One-time per environment: set email + password on the seed owner row.
 * Preserves SEED_USER_ID and all finance FKs.
 *
 * Usage: BOOTSTRAP_EMAIL=... BOOTSTRAP_PASSWORD=... bun run bootstrap-owner
 */
import { eq } from "drizzle-orm";
import { SEED_USER_ID } from "../src/db/constants";
import { hashPassword } from "../src/lib/password";
import { db, schema } from "./lib/db";

const email = process.env.BOOTSTRAP_EMAIL?.trim().toLowerCase();
const password = process.env.BOOTSTRAP_PASSWORD;

if (!email || !password) {
  console.error("Set BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD");
  process.exit(1);
}

const passwordHash = await hashPassword(password);

const existing = await db
  .select({ id: schema.users.id })
  .from(schema.users)
  .where(eq(schema.users.id, SEED_USER_ID))
  .limit(1);

if (existing.length === 0) {
  await db.insert(schema.users).values({
    id: SEED_USER_ID,
    email,
    passwordHash,
    tokenVersion: 0,
  });
  console.log(`Created seed owner ${SEED_USER_ID} (${email})`);
} else {
  await db
    .update(schema.users)
    .set({ email, passwordHash })
    .where(eq(schema.users.id, SEED_USER_ID));
  console.log(`Updated seed owner ${SEED_USER_ID} (${email})`);
}
