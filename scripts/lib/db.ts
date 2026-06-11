/**
 * DB client for CLI scripts (no `server-only` — safe to import from bun scripts).
 */
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { readFileSync } from "node:fs";
import ws from "ws";
import * as schema from "../../src/db/schema";

function configureLocalNeonProxy(connectionString: string) {
  let hostname = "";
  try {
    hostname = new URL(
      connectionString.replace(/^postgres:/, "postgresql:"),
    ).hostname;
  } catch {
    return;
  }
  if (hostname !== "db.localtest.me") return;

  const isLocaltest = (host: string) =>
    host === "db.localtest.me" || host.endsWith(".localtest.me");

  neonConfig.fetchEndpoint = (host) =>
    isLocaltest(host)
      ? "http://db.localtest.me:4444/sql"
      : `https://${host}:443/sql`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.wsProxy = (host) =>
    isLocaltest(host) ? "db.localtest.me:4444/v2" : `${host}/v2`;
  neonConfig.pipelineConnect = false;
  neonConfig.poolQueryViaFetch = true;
  neonConfig.webSocketConstructor = ws;
}

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

const databaseUrl = loadDatabaseUrl();
configureLocalNeonProxy(databaseUrl);
const sql = neon(databaseUrl);
export const db = drizzle(sql, { schema });
export { schema };
