import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { ForbiddenError } from "./forbidden";

export type CurrentUser = {
  id: string;
  email: string | null;
};

async function sessionUser(): Promise<CurrentUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    email: session.user.email ?? null,
  };
}

/** For server components — redirects to login when unauthenticated. */
export async function requireCurrentUser(): Promise<CurrentUser> {
  const user = await sessionUser();
  if (!user) redirect("/login");
  return user;
}

/** For server actions — throws so the client gets an error instead of a redirect. */
export async function requireCurrentUserAction(): Promise<CurrentUser> {
  const user = await sessionUser();
  if (!user) throw new ForbiddenError("Not authenticated");
  return user;
}
