import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db, schema } from "@/db";
import { checkLoginRateLimit } from "@/lib/rate-limit";
import { authConfig } from "@/auth.config";

/** How often to re-read user.token_version from Neon (revocation check). */
const TOKEN_VERSION_CHECK_MS = 5 * 60 * 1000;
/**
 * If the revocation check errors (Neon blip), keep the JWT only while the
 * last successful check is younger than this — beyond it, fail closed so a
 * DB outage cannot keep a revoked session alive indefinitely.
 */
const TOKEN_VERSION_GRACE_MS = 15 * 60 * 1000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: DrizzleAdapter(db),
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const email = String(credentials?.email ?? "")
          .trim()
          .toLowerCase();
        const password = String(credentials?.password ?? "");
        if (!email || !password) return null;

        const ip =
          request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          request?.headers?.get("x-real-ip") ??
          "unknown";
        if (!(await checkLoginRateLimit(ip, email))) return null;

        const [user] = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.email, email))
          .limit(1);
        if (!user?.passwordHash) return null;

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          tokenVersion: user.tokenVersion,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user) {
        token.sub = user.id;
        token.email = user.email;
        token.name = user.name;
        // Default token_version is 0 — must not use truthiness checks later.
        token.tokenVersion =
          (user as { tokenVersion?: number }).tokenVersion ?? 0;
        token.tvCheckedAt = Date.now();
        return token;
      }

      if (!token.sub) return token;

      const lastCheck =
        typeof token.tvCheckedAt === "number" ? token.tvCheckedAt : 0;
      const needsVersionCheck =
        trigger === "signIn" ||
        trigger === "signUp" ||
        trigger === "update" ||
        // undefined only — 0 is a valid stored version
        token.tokenVersion === undefined ||
        Date.now() - lastCheck >= TOKEN_VERSION_CHECK_MS;

      if (!needsVersionCheck) {
        return token;
      }

      try {
        const [row] = await db
          .select({ tokenVersion: schema.users.tokenVersion })
          .from(schema.users)
          .where(eq(schema.users.id, token.sub))
          .limit(1);

        if (!row) return null;

        // Revoked after bump-token-version
        if (
          token.tokenVersion !== undefined &&
          row.tokenVersion !== token.tokenVersion
        ) {
          return null;
        }

        token.tokenVersion = row.tokenVersion;
        token.tvCheckedAt = Date.now();
        return token;
      } catch (err) {
        // Transient Neon blips must not wipe the session mid-action
        // (that previously surfaced as ForbiddenError after ~30s hangs),
        // but only within a bounded grace window — a sustained outage must
        // not indefinitely defer revocation.
        if (Date.now() - lastCheck < TOKEN_VERSION_GRACE_MS) {
          console.error(
            "[auth] token_version check failed; keeping JWT within grace window",
            err,
          );
          return token;
        }
        console.error(
          "[auth] token_version check failed beyond grace window; revoking session",
          err,
        );
        return null;
      }
    },
    session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
    ...authConfig.callbacks,
  },
});

export { hashPassword } from "@/lib/password";
