"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { moneyKeys } from "./keys";

export function useMoneyQueryUser() {
  const { data, status } = useSession();
  return status === "authenticated" ? data.user.id : null;
}

// Writes can affect related rows outside the current page. Invalidate the
// user's read families rather than inferring those relationships in the UI.
export function useInvalidateMoneyReads() {
  const client = useQueryClient();
  const userId = useMoneyQueryUser();
  return () => {
    if (userId) void client.invalidateQueries({ queryKey: moneyKeys.all(userId) });
  };
}
