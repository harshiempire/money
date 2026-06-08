"use client";

import { signOut } from "next-auth/react";
import { cn } from "@/lib/cn";

export function SignOutButton({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/login" })}
      className={cn(
        "text-sm text-[var(--color-text-secondary)] underline-offset-4 transition-colors hover:text-[var(--color-text)] hover:underline",
        className,
      )}
    >
      {children ?? "Sign out"}
    </button>
  );
}
