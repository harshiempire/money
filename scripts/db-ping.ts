/** Quick Neon connectivity check. Usage: bun run db:ping */
import { sql } from "drizzle-orm";
import { db } from "./lib/db";

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
    "\nTips: Resume project at https://console.neon.tech if suspended.",
    "\nOn mobile data, try Wi‑Fi.",
  );
  process.exit(1);
}
