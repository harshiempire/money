import "server-only";
import ws from "ws";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

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
}

neonConfig.webSocketConstructor = ws;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

configureLocalNeonProxy(connectionString);

const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema });
export { schema };
