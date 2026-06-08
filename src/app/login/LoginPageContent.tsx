"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LoginForm } from "./LoginForm";

export function LoginPageContent() {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/");
    }
  }, [status, router]);

  if (status === "loading" || status === "authenticated") {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <p className="text-sm text-neutral-500">Loading…</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface p-8">
      <div className="w-full max-w-sm rounded-lg border border-border-subtle bg-surface-raised p-8 shadow-[var(--shadow-card)]">
        <p className="text-lg font-semibold tracking-tight">Money</p>
        <p className="mt-0.5 text-xs text-neutral-500">Split-aware net spend</p>
        <h1 className="mt-6 text-xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          <a href="/register" className="underline-offset-4 hover:underline">
            Create an account
          </a>
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
