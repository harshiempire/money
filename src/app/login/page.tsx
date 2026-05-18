import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        <a href="/register" className="underline-offset-4 hover:underline">
          Create an account
        </a>
      </p>
      <LoginForm />
    </main>
  );
}
