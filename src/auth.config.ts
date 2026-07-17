import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe subset of the auth config. Used by middleware (Vercel Edge
 * runtime, no Node TCP sockets / crypto) — must not import `db`, the
 * Credentials provider, or any adapter. The full DB-backed config lives in
 * `@/auth` and extends this.
 */
export const authConfig = {
  pages: { signIn: "/login" },
  trustHost: true,
  providers: [],
  callbacks: {
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
} satisfies NextAuthConfig;
