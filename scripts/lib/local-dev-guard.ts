import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * True only when DATABASE_URL is exactly the local-dev branch URL stored on
 * this machine (default ~/.money-scratch/local-dev/dburl, override with
 * LOCAL_DEV_DBURL_FILE). Keeps database identifiers out of the repo (it is
 * public) while refusing production — which .env supplies by default.
 */
export function isLocalDevDatabase(): boolean {
  const file = process.env.LOCAL_DEV_DBURL_FILE ?? join(homedir(), ".money-scratch", "local-dev", "dburl");
  let expected = "";
  try {
    expected = readFileSync(file, "utf8").trim();
  } catch {
    return false;
  }
  return expected.length > 0 && process.env.DATABASE_URL?.trim() === expected;
}

export function requireLocalDevDatabase(): void {
  if (!isLocalDevDatabase()) {
    console.error("Refusing to run: DATABASE_URL is not the local-dev branch URL (see scripts/lib/local-dev-guard.ts).");
    process.exit(2);
  }
}
