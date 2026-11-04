"use client";

import { useQueryClient } from "@tanstack/react-query";
import { signOut } from "next-auth/react";

export function SignOutButton() {
  const queryClient = useQueryClient();
  return (
    <button
      type="button"
      onClick={() => {
        queryClient.clear();
        void signOut({ callbackUrl: "/login" });
      }}
      className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
    >
      Sign out
    </button>
  );
}
