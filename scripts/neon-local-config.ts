/**
 * Preload for local Neon proxy (db.localtest.me + port 4444).
 * Usage: NODE_OPTIONS='--import ./scripts/neon-local-config.ts' bun run dev
 */
import { readFileSync } from "node:fs";
import ws from "ws";
import { neonConfig } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?\s*$/);
        if (m) process.env.DATABASE_URL = m[1];
      }
    } catch {
      /* ignore */
    }
  }
}

const connectionString = process.env.DATABASE_URL ?? "";
let hostname = "";
try {
  hostname = new URL(connectionString.replace(/^postgres:/, "postgresql:")).hostname;
} catch {
  /* ignore */
}

function isLocaltest(host: string): boolean {
  return host === "db.localtest.me" || host.endsWith(".localtest.me");
}

if (hostname === "db.localtest.me") {
  neonConfig.fetchEndpoint = (host) => {
    if (isLocaltest(host)) return `http://db.localtest.me:4444/sql`;
    return `https://${host}:443/sql`;
  };
  neonConfig.useSecureWebSocket = false;
  neonConfig.wsProxy = (host) =>
    isLocaltest(host) ? `db.localtest.me:4444/v2` : `${host}/v2`;
  neonConfig.pipelineConnect = false;
  neonConfig.poolQueryViaFetch = true;
  neonConfig.webSocketConstructor = ws;
}
