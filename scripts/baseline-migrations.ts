/**
 * Mark migrations 0000–0002 as already applied when the DB was created via
 * `db:push` (schema exists but drizzle.__drizzle_migrations is empty).
 *
 * Usage: bun run scripts/baseline-migrations.ts
 * Then:  bun run db:migrate   (applies 0003+ only)
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";

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
  throw new Error("DATABASE_URL not set");
}

const journal = JSON.parse(
  readFileSync("drizzle/migrations/meta/_journal.json", "utf8"),
) as {
  entries: Array<{ tag: string; when: number }>;
};

/** Baseline through 0002 (schema already on DB from push). */
const BASELINE_TAGS = new Set([
  "0000_brief_trish_tilby",
  "0001_married_kitty_pryde",
  "0002_greedy_rawhide_kid",
]);

const url = loadDatabaseUrl();
const sql = postgres(url, { max: 1 });

const existing = await sql<{ hash: string }[]>`
  SELECT hash FROM drizzle.__drizzle_migrations
`;
const existingHashes = new Set(existing.map((r) => r.hash));

let inserted = 0;
for (const entry of journal.entries) {
  if (!BASELINE_TAGS.has(entry.tag)) continue;
  const body = readFileSync(`drizzle/migrations/${entry.tag}.sql`, "utf8");
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  if (existingHashes.has(hash)) continue;
  await sql`
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
    VALUES (${hash}, ${entry.when})
  `;
  inserted++;
  console.log(`Baselined: ${entry.tag}`);
}

await sql.end();
console.log(
  inserted === 0
    ? "Nothing to baseline (0000–0002 already recorded)."
    : `Baselined ${inserted} migration(s). Run: bun run db:migrate`,
);
