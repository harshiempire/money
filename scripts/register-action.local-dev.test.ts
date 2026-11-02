/**
 * Integration check for open registration against the Neon `local-dev`
 * branch ONLY. Skipped in a normal `bun test` run (any other DATABASE_URL),
 * and nothing that touches the database is even imported unless it runs.
 *
 * Runs the real exported action (asFormAction(definePublicAction(...))) with
 * Next's request APIs and Auth.js signIn stubbed, so each branch can be
 * forced. Real sign-in cookies / redirects were verified through `next dev`.
 *
 *   DATABASE_URL="$(cat ~/.money-scratch/local-dev/dburl)" \
 *     bun test --conditions=react-server --preload="$HOME/.money-scratch/neon-dns.cjs" \
 *     ./scripts/register-action.local-dev.test.ts
 */
import { expect, mock, test } from "bun:test";

const { isLocalDevDatabase } = await import("./lib/local-dev-guard");
const onLocalDev = isLocalDevDatabase();

test.skipIf(!onLocalDev)("registration: validation, rate limit, duplicates, sign-in outcomes", async () => {
  const realPassword = await import("../src/lib/password");
  class AuthError extends Error {}
  let rateLimitOk = true;
  let signInMode: "ok" | "auth-error" | "crash" = "ok";
  const ips: string[] = [];
  mock.module("next-auth", () => ({ AuthError, default: () => ({}) }));
  mock.module("@/auth", () => ({
    hashPassword: realPassword.hashPassword,
    signIn: async () => {
      if (signInMode === "auth-error") throw new AuthError("CredentialsSignin");
      if (signInMode === "crash") throw new Error("boom");
    },
    auth: async () => null,
  }));
  mock.module("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }) }));
  mock.module("next/navigation", () => ({
    redirect: (to: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to};307;` }); },
    unstable_rethrow: (e: { digest?: unknown }) => { if (typeof e?.digest === "string" && e.digest.startsWith("NEXT_REDIRECT")) throw e; },
  }));
  mock.module("next/cache", () => ({ revalidatePath: () => {} }));
  mock.module("@/lib/rate-limit", () => ({
    checkRegisterRateLimit: async (ip: string) => { ips.push(ip); return rateLimitOk; },
    checkLoginRateLimit: async () => true,
  }));

  const { eq, like } = await import("drizzle-orm");
  const bcrypt = (await import("bcryptjs")).default;
  const { db, schema } = await import("../src/db");
  const { registerUser } = await import("../src/app/auth/actions");

  const tag = crypto.randomUUID().slice(0, 8);
  const email = (s: string) => `reg-test-${tag}-${s}@example.invalid`;
  const pw = "correct horse battery";
  const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
  const submit = async (f: FormData) => {
    try { return await registerUser({}, f); }
    catch (e) { const d = (e as { digest?: string }).digest; if (d?.startsWith("NEXT_REDIRECT")) return `redirect ${d.split(";")[2]}`; throw e; }
  };

  try {
    expect(await submit(form({ email: "nope", password: pw, confirm: pw }))).toEqual({ error: "Enter a valid email address.", field: "email" });
    expect(await submit(form({ email: email("a"), password: "short", confirm: "short" }))).toEqual({ error: "Password must be at least 12 characters.", field: "password" });
    expect(await submit(form({ email: email("a"), password: pw, confirm: `${pw}x` }))).toEqual({ error: "Passwords do not match.", field: "confirm" });
    expect(ips).toEqual([]); // validation runs before the rate limit

    rateLimitOk = false;
    expect(await submit(form({ email: email("a"), password: pw, confirm: pw }))).toEqual({ error: "Too many registration attempts. Try again later." });
    expect(ips).toEqual(["203.0.113.9"]);
    rateLimitOk = true;

    expect(await submit(form({ email: `  ${email("A").toUpperCase()} `, password: pw, confirm: pw, name: "  Asha  " }))).toBe("redirect /");
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email("a")));
    expect(user?.name).toBe("Asha");
    expect(user?.tokenVersion).toBe(0);
    expect(await bcrypt.compare(pw, user!.passwordHash!)).toBe(true);
    expect((await db.select().from(schema.categories).where(eq(schema.categories.userId, user!.id))).length).toBeGreaterThan(0);

    expect(await submit(form({ email: email("a"), password: pw, confirm: pw }))).toEqual({ error: "An account with this email already exists." });

    signInMode = "auth-error";
    expect(await submit(form({ email: email("b"), password: pw, confirm: pw }))).toEqual({ error: "Account created but sign-in failed. Try logging in." });
    signInMode = "crash";
    expect(await submit(form({ email: email("c"), password: pw, confirm: pw }))).toEqual({ error: "Something went wrong. Please try again." });
  } finally {
    await db.delete(schema.users).where(like(schema.users.email, `reg-test-${tag}-%@example.invalid`));
    expect((await db.select().from(schema.users).where(like(schema.users.email, `reg-test-${tag}-%`))).length).toBe(0);
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  }
}, 60_000);
