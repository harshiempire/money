import "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email?: string | null;
      name?: string | null;
      image?: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    /** Matches user.token_version; 0 is valid (do not treat as missing). */
    tokenVersion?: number;
    /** epoch ms of last Neon token_version re-check */
    tvCheckedAt?: number;
  }
}
