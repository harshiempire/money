import "server-only";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { hashPassword, signIn } from "@/auth";
import { schema } from "@/db";
import { ensureDefaultCategories } from "@/db/seed-categories";
import type { ActionSpec } from "@/lib/action/core";
import { Conflict, Invalid } from "@/lib/action/errors";
import { query, type Db } from "@/lib/action/services";
import { checkRegisterRateLimit } from "@/lib/rate-limit";

/**
 * Open registration, behind ./actions.ts. Runs WITHOUT a session
 * (definePublicAction): the handler cannot ask for CurrentUser.
 *
 * Same steps, order and messages as the pre-Effect version:
 *   read fields → validate email / length / confirmation → rate limit (by
 *   IP) → refuse an existing email → hash + insert → default categories →
 *   sign in → redirect("/").
 * redirect() works by throwing; runAction re-throws it via unstable_rethrow.
 *
 * Integration check: scripts/register-action.local-dev.test.ts.
 */

const MIN_PASSWORD_LENGTH = 12;

export const registerUserSpec: ActionSpec<FormData, FormData, void, Db> = {
  input: Schema.instanceOf(FormData, { expected: "form data" }),
  handler: Effect.fn("registerUser")(function* (formData) {
    const email = String(formData.get("email") ?? "")
      .trim()
      .toLowerCase();
    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm") ?? "");
    const name = String(formData.get("name") ?? "").trim() || null;

    if (!email || !email.includes("@")) {
      return yield* new Invalid({ message: "Enter a valid email address.", field: "email" });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return yield* new Invalid({
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        field: "password",
      });
    }
    if (password !== confirm) {
      return yield* new Invalid({ message: "Passwords do not match.", field: "confirm" });
    }

    const hdrs = yield* Effect.promise(() => headers());
    const ip =
      hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      hdrs.get("x-real-ip") ??
      "unknown";
    if (!(yield* Effect.promise(() => checkRegisterRateLimit(ip)))) {
      return yield* new Conflict({ message: "Too many registration attempts. Try again later." });
    }

    const [existing] = yield* query((db) =>
      db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1),
    );
    if (existing) {
      return yield* new Conflict({ message: "An account with this email already exists." });
    }

    const passwordHash = yield* Effect.promise(() => hashPassword(password));
    const [created] = yield* query((db) =>
      db
        .insert(schema.users)
        .values({ email, name, passwordHash, tokenVersion: 0 })
        .returning({ id: schema.users.id }),
    );

    yield* Effect.promise(() => ensureDefaultCategories(created.id));

    // AuthError → the old message; anything else stays a defect (logged,
    // generic message), as a re-thrown error was before.
    yield* Effect.tryPromise({
      try: () => signIn("credentials", { email, password, redirect: false }),
      catch: (err) => err,
    }).pipe(
      Effect.catch((err) =>
        err instanceof AuthError
          ? Effect.fail(new Conflict({ message: "Account created but sign-in failed. Try logging in." }))
          : Effect.die(err),
      ),
    );

    yield* Effect.sync(() => redirect("/"));
  }),
};
