"use client";

import { useEffect, useRef, useState } from "react";
import { SessionProvider as NextAuthSessionProvider, useSession } from "next-auth/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createSessionQueryClient } from "@/lib/query/client";

/**
 * One query cache per browser tab. Every query key starts with the user id and
 * only runs once that id is known, so one user's cached reads can never answer
 * another user's query. The cache is still cleared whenever the user changes
 * (sign-out, a different sign-in) so nothing from the previous user lingers.
 * Children are NOT remounted on a user change: session status goes
 * "loading" -> authenticated on every page load, and remounting the tree then
 * would reset every form and panel.
 */
function TenantQueries({ children }: { children: React.ReactNode }) {
  const [client] = useState(createSessionQueryClient);
  const { data, status } = useSession();
  const userId = status === "authenticated" ? data.user.id : null;
  const seenUser = useRef<string | null>(userId);
  useEffect(() => {
    if (seenUser.current !== userId) {
      // clear() also cancels in-flight queries, so a late response for the
      // previous user can't refill the cache.
      client.clear();
      seenUser.current = userId;
    }
  }, [client, userId]);
  useEffect(() => () => client.clear(), [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  return <NextAuthSessionProvider><TenantQueries>{children}</TenantQueries></NextAuthSessionProvider>;
}
