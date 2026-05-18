import { defineConfig } from "drizzle-kit";
import { readFileSync } from "node:fs";

// drizzle-kit runs under Node, so it doesn't inherit Bun's auto-loaded
// .env.local. Pull it in manually so `bun run db:*` works without the user
// having to source env vars.
if (!process.env.DATABASE_URL) {
  for (const envFile of [".env.local", ".env"]) {
    try {
      const raw = readFileSync(envFile, "utf8");
      for (const line of raw.split("\n")) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/i);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
      }
    } catch {
      /* file missing */
    }
  }
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
