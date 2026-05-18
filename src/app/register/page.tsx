import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { RegisterForm } from "./RegisterForm";

export default async function RegisterPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-2xl font-semibold">Create account</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Already have an account?{" "}
        <a href="/login" className="underline-offset-4 hover:underline">
          Sign in
        </a>
      </p>
      <RegisterForm />
    </main>
  );
}
