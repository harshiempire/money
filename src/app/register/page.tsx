import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { RegisterForm } from "./RegisterForm";

export default async function RegisterPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface p-8">
      <div className="w-full max-w-sm rounded-lg border border-border-subtle bg-surface-raised p-8 shadow-[var(--shadow-card)]">
        <p className="text-lg font-semibold tracking-tight">Money</p>
        <p className="mt-0.5 text-xs text-neutral-500">Split-aware net spend</p>
        <h1 className="mt-6 text-xl font-semibold">Create account</h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Already have an account?{" "}
          <a href="/login" className="underline-offset-4 hover:underline">
            Sign in
          </a>
        </p>
        <RegisterForm />
      </div>
    </main>
  );
}
