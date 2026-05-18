/**
 * Normalize DATABASE_URL for Postgres clients.
 * Strips `channel_binding=require` (breaks some drivers/networks).
 */
export function resolveDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw?.trim()) {
    throw new Error("DATABASE_URL is not set");
  }
  try {
    const url = new URL(raw);
    url.searchParams.delete("channel_binding");
    if (!url.searchParams.has("sslmode")) {
      url.searchParams.set("sslmode", "require");
    }
    return url.toString();
  } catch {
    return raw;
  }
}
