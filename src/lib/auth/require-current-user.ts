import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { ForbiddenError } from "./forbidden";

export type CurrentUser = {
  id: string;
  email: string | null;
};

async function sessionUser(): Promise<CurrentUser | null> {
  try {
    const session = await auth();
    if (!session || typeof session !== "object" || !("user" in session)) {
      return null;
    }
    const user = session.user as { id?: string; email?: string | null } | undefined;
    if (!user?.id) return null;
    return {
      id: user.id,
      email: user.email ?? null,
    };
  } catch (err) {
    console.error("[auth] sessionUser failed", err);
    return null;
  }
}

export async function requireCurrentUser(): Promise<CurrentUser> {
  const user = await sessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireCurrentUserAction(): Promise<CurrentUser> {
  const user = await sessionUser();
  if (!user) throw new ForbiddenError("Not authenticated");
  return user;
}
