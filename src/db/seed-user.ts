import "server-only";

export { SEED_USER_ID } from "./constants";

/** @deprecated Use requireCurrentUser() — runtime auto-provisioning removed. */
export async function ensureSeedUser(): Promise<string> {
  throw new Error(
    "ensureSeedUser() is deprecated. Use requireCurrentUser() from @/lib/auth/require-current-user.",
  );
}
