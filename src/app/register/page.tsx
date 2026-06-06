import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { RegisterForm } from "./RegisterForm";
import { IconLogo } from "@/components/icons";

export default async function RegisterPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  return (
    <main className="flex min-h-screen">
      <div className="hidden w-1/2 flex-col justify-between bg-gradient-to-br from-[var(--color-accent)] to-emerald-800 p-12 text-white lg:flex">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-white/20 p-2 backdrop-blur">
            <IconLogo className="h-8 w-8 [&_rect]:fill-white" />
          </div>
          <span className="text-xl font-semibold">Money</span>
        </div>
        <div>
          <h2 className="text-3xl font-semibold leading-tight">
            Start tracking your real spend
          </h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-white/80">
            Create your account and import your first bank statement.
            Your data is private and scoped to your account.
          </p>
        </div>
        <p className="text-xs text-white/50">
          Open registration · Secure credentials auth
        </p>
      </div>

      <div className="flex flex-1 items-center justify-center bg-[var(--color-surface)] p-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <IconLogo />
            <span className="text-lg font-semibold">Money</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Create account</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Already have an account?{" "}
            <Link
              href="/login"
              className="font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
            >
              Sign in
            </Link>
          </p>
          <RegisterForm />
        </div>
      </div>
    </main>
  );
}
