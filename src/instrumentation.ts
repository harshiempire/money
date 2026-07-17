export async function register() {
  // register() runs once per runtime the app boots into — both "nodejs"
  // and "edge" (the latter because middleware runs on Edge). The DB check
  // below uses postgres.js (raw TCP sockets), which Edge can't run; skip it
  // there so it doesn't crash middleware on every request.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SKIP_AUTH_BOOTSTRAP_CHECK === "1") return;
  if (process.env.NODE_ENV !== "production") return;

  const { eq } = await import("drizzle-orm");
  const { db, schema } = await import("@/db");
  const { SEED_USER_ID } = await import("@/db/seed-user");

  const [row] = await db
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, SEED_USER_ID))
    .limit(1);

  if (!row?.passwordHash) {
    throw new Error(
      "Seed owner not bootstrapped (missing password_hash). Run: bun run bootstrap-owner",
    );
  }
}
