import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolveDatabaseUrl } from "./connection-url";
import * as schema from "./schema";

/**
 * TCP via postgres.js (documented in AGENTS.md).
 *
 * Neon WebSocket Pool was flaky in Next dev:
 * - simple selects → opaque "Failed query"
 * - db.transaction (saveNetEvent) → "Connection terminated due to connection timeout"
 *
 * postgres.js uses the pooler URL over TCP and supports real transactions.
 */
const client = postgres(resolveDatabaseUrl(), {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 15,
  // prepare: false is recommended for PgBouncer / Neon pooler transaction mode
  prepare: false,
});

export const db = drizzle(client, { schema });
export { schema };
