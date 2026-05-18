/** Quick DB connectivity check. Usage: bun run db:ping */
import { sql } from "drizzle-orm";
import { resolveDatabaseUrl } from "../src/db/connection-url";
import { db } from "./lib/db";

console.log("Host:", new URL(resolveDatabaseUrl()).hostname);

try {
  await db.execute(sql`select 1 as ok`);
  console.log("Database OK");
} catch (err) {
  const cause =
    err &&
    typeof err === "object" &&
    "cause" in err &&
    (err as { cause?: unknown }).cause instanceof Error
      ? (err as { cause: Error }).cause.message
      : "";
  console.error("Database unreachable:", err instanceof Error ? err.message : err);
  if (cause) console.error("Cause:", cause);
  console.error(
    "\nTips:",
    "\n1. https://console.neon.tech — resume project if suspended",
    "\n2. Copy fresh pooled connection string into DATABASE_URL",
    "\n3. On mobile data, try Wi‑Fi",
  );
  process.exit(1);
}
