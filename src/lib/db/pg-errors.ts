/** Postgres undefined_table. Migration not applied yet. */
export function isMissingTable(err: unknown): boolean {
  const code = (value: unknown) =>
    value && typeof value === "object" && "code" in value ? (value as { code: unknown }).code : null;
  return code(err) === "42P01" || code((err as { cause?: unknown } | null)?.cause) === "42P01";
}
