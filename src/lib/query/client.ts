"use client";

import { QueryClient } from "@tanstack/react-query";

// No module singleton: each mounted session boundary owns its cache.
export function createSessionQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 5 * 60_000,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}
