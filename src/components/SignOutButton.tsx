"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/login" })}
      className="w-full rounded-md px-2 py-1.5 text-left text-sm text-neutral-600 hover:bg-surface-muted dark:text-neutral-400"
    >
      Sign out
    </button>
  );
}
