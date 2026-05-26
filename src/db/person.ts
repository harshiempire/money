import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import { db, schema } from "./index";

const PG_UNIQUE_VIOLATION = "23505";

type DbClient = NeonDatabase<typeof schema>;

export async function getOrCreatePerson(
  userId: string,
  name: string,
  client: DbClient = db,
): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Person name must not be empty");
  }

  const [existing] = await client
    .select({ id: schema.persons.id })
    .from(schema.persons)
    .where(
      and(
        eq(schema.persons.userId, userId),
        sql`lower(${schema.persons.name}) = lower(${trimmed})`,
      ),
    )
    .limit(1);

  if (existing) return existing.id;

  try {
    const [created] = await client
      .insert(schema.persons)
      .values({ userId, name: trimmed })
      .returning({ id: schema.persons.id });
    return created.id;
  } catch (err) {
    const code =
      err &&
      typeof err === "object" &&
      "code" in err &&
      typeof (err as { code: unknown }).code === "string"
        ? (err as { code: string }).code
        : null;
    if (code !== PG_UNIQUE_VIOLATION) throw err;

    const [row] = await client
      .select({ id: schema.persons.id })
      .from(schema.persons)
      .where(
        and(
          eq(schema.persons.userId, userId),
          sql`lower(${schema.persons.name}) = lower(${trimmed})`,
        ),
      )
      .limit(1);
    if (!row) throw err;
    return row.id;
  }
}
