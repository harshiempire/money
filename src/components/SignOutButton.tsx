"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/login" })}
      className="text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
    >
      Sign out
    </button>
  );
}
