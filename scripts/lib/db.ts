/**
 * DB client for CLI scripts (no `server-only` — safe to import from bun scripts).
 */
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolveDatabaseUrl } from "../../src/db/connection-url";
import * as schema from "../../src/db/schema";

function loadEnvDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?\s*$/);
        if (m) {
          process.env.DATABASE_URL = m[1]!;
          return;
        }
      }
    } catch {
      /* ignore */
    }
  }
}

loadEnvDatabaseUrl();

const client = postgres(resolveDatabaseUrl(), {
  max: 1,
  connect_timeout: 15,
});

export const db = drizzle(client, { schema });
export { schema };
