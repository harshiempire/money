/**
 * Normalize DATABASE_URL for drivers that reject Neon extras.
 * Strips `channel_binding` (can break some TCP clients).
 */
export function resolveDatabaseUrl(
  raw = process.env.DATABASE_URL,
): string {
  if (!raw) {
    throw new Error("DATABASE_URL is not set");
  }
  try {
    const url = new URL(raw);
    url.searchParams.delete("channel_binding");
    return url.toString();
  } catch {
    return raw;
  }
}
