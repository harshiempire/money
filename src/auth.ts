import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db, schema } from "@/db";
import { BCRYPT_ROUNDS } from "@/lib/password";
import { checkLoginRateLimit } from "@/lib/rate-limit";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db),
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/login" },
  trustHost: true,
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
        // #region agent log
        const _dbg = (message: string, data: Record<string, unknown>, hypothesisId: string) =>
          fetch("http://127.0.0.1:7379/ingest/92c017b4-ffd6-4d9c-8805-6620c34ef33c", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8f76a4" },
            body: JSON.stringify({
              sessionId: "8f76a4",
              location: "src/auth.ts:authorize",
              message,
              data,
              hypothesisId,
              timestamp: Date.now(),
            }),
          }).catch(() => {});
        // #endregion
        if (!email || !password) {
          // #region agent log
          await _dbg("authorize:empty_credentials", { hasEmail: !!email, hasPassword: !!password }, "C");
          // #endregion
          return null;
        }

        const ip =
          request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          request?.headers?.get("x-real-ip") ??
          "unknown";
        const rateOk = await checkLoginRateLimit(ip, email);
        // #region agent log
        await _dbg("authorize:rate_limit", { rateOk, ipPrefix: ip.slice(0, 8) }, "A");
        // #endregion
        if (!rateOk) return null;

        let user: (typeof schema.users.$inferSelect) | undefined;
        try {
          [user] = await db
            .select()
            .from(schema.users)
            .where(eq(schema.users.email, email))
            .limit(1);
        } catch (err) {
          const cause =
            err &&
            typeof err === "object" &&
            "cause" in err &&
            (err as { cause?: unknown }).cause instanceof Error
              ? (err as { cause: Error }).cause.message
              : undefined;
          // #region agent log
          await _dbg(
            "authorize:db_error",
            {
              err: err instanceof Error ? err.message : String(err),
              cause: cause?.slice(0, 120),
            },
            "F",
          );
          // #endregion
          return null;
        }
        // #region agent log
        await _dbg(
          "authorize:user_lookup",
          {
            found: !!user,
            userId: user?.id?.slice(0, 8),
            hasHash: !!user?.passwordHash,
            hashLen: user?.passwordHash?.length ?? 0,
          },
          "B",
        );
        // #endregion
        if (!user?.passwordHash) return null;

        const ok = await bcrypt.compare(password, user.passwordHash);
        // #region agent log
        await _dbg("authorize:bcrypt", { ok, pwdLen: password.length }, "D");
        // #endregion
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
        token.tokenVersion =
          (user as { tokenVersion?: number }).tokenVersion ?? 0;
        return token;
      }
      if (!token.sub) return token;
      if (trigger === "signIn" || trigger === "signUp" || !token.tokenVersion) {
        const [row] = await db
          .select({ tokenVersion: schema.users.tokenVersion })
          .from(schema.users)
          .where(eq(schema.users.id, token.sub))
          .limit(1);
        if (!row) return null;
        token.tokenVersion = row.tokenVersion;
        return token;
      }
      const [row] = await db
        .select({ tokenVersion: schema.users.tokenVersion })
        .from(schema.users)
        .where(eq(schema.users.id, token.sub))
        .limit(1);
      if (!row || row.tokenVersion !== token.tokenVersion) return null;
      return token;
    },
    session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      if (
        pathname.startsWith("/login") ||
        pathname.startsWith("/register") ||
        pathname.startsWith("/api/auth")
      ) {
        return true;
      }
      return !!auth?.user;
    },
  },
});

export { hashPassword } from "@/lib/password";
