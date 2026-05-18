/**
 * DB client for CLI scripts (no `server-only` — safe to import from bun scripts).
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { readFileSync } from "node:fs";
import * as schema from "../../src/db/schema";

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?\s*$/);
        if (m) return m[1]!;
      }
    } catch {
      /* ignore */
    }
  }
  throw new Error("DATABASE_URL is not set");
}

const sql = neon(loadDatabaseUrl());
export const db = drizzle(sql, { schema });
export { schema };
