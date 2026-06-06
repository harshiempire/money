"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LoginForm } from "./LoginForm";
import { IconLogo } from "@/components/icons";

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
      <main className="flex min-h-screen items-center justify-center bg-[var(--color-surface)] p-8">
        <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen">
      {/* Brand panel */}
      <div className="hidden w-1/2 flex-col justify-between bg-gradient-to-br from-[var(--color-accent)] to-emerald-800 p-12 text-white lg:flex">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-white/20 p-2 backdrop-blur">
            <IconLogo className="h-8 w-8 [&_rect]:fill-white" />
          </div>
          <span className="text-xl font-semibold">Money</span>
        </div>
        <div>
          <h2 className="text-3xl font-semibold leading-tight">
            Know what you actually spent
          </h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-white/80">
            Split-aware net spend tracking. Import your bank statements,
            categorize transactions, track reimbursements, and see your true
            consumption — not just gross debits.
          </p>
        </div>
        <p className="text-xs text-white/50">
          Bank of Baroda PDF import · Multi-tenant · Split settlements
        </p>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center bg-[var(--color-surface)] p-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <IconLogo />
            <span className="text-lg font-semibold">Money</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Sign in to your account to continue
          </p>
          <LoginForm />
          <p className="mt-6 text-center text-sm text-[var(--color-text-muted)]">
            Don&apos;t have an account?{" "}
            <Link
              href="/register"
              className="font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
            >
              Create one
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
