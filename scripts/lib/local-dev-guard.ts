import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Guards for scripts and tests that write to a database. The repo is public,
 * so no database identifier is written here: a URL is accepted only when it
 * equals one stored in a file on this machine.
 *
 * - Test database (preferred, fast): the local Docker Postgres used by the
 *   ledger DB tests — ~/.money-scratch/ledger-test/dburl
 *   (override: MONEY_LEDGER_TEST_DBURL_FILE).
 * - local-dev: the Neon branch holding a copy of production data —
 *   ~/.money-scratch/local-dev/dburl (override: LOCAL_DEV_DBURL_FILE).
 *
 * Production (which .env supplies by default) matches neither, so it is refused.
 */
const scratch = join(homedir(), ".money-scratch");

function urlFromFile(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function matches(file: string): boolean {
  const expected = urlFromFile(file);
  return expected.length > 0 && process.env.DATABASE_URL?.trim() === expected;
}

export function isTestDatabase(): boolean {
  return matches(process.env.MONEY_LEDGER_TEST_DBURL_FILE ?? join(scratch, "ledger-test", "dburl"));
}

export function isLocalDevDatabase(): boolean {
  return matches(process.env.LOCAL_DEV_DBURL_FILE ?? join(scratch, "local-dev", "dburl"));
}

/** For DB tests: the Docker test database or local-dev; never anything else. */
export function isSafeDatabase(): boolean {
  return isTestDatabase() || isLocalDevDatabase();
}

export function requireSafeDatabase(): void {
  if (!isSafeDatabase()) {
    console.error(
      "Refusing to run: DATABASE_URL is neither the local test database nor the local-dev branch (see scripts/lib/local-dev-guard.ts).",
    );
    process.exit(2);
  }
}

/** Kept for scripts that must run against local-dev specifically. */
export function requireLocalDevDatabase(): void {
  if (!isLocalDevDatabase()) {
    console.error("Refusing to run: DATABASE_URL is not the local-dev branch URL (see scripts/lib/local-dev-guard.ts).");
    process.exit(2);
  }
}
