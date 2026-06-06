"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const form = e.currentTarget;
    const email = (form.elements.namedItem("email") as HTMLInputElement).value;
    const password = (form.elements.namedItem("password") as HTMLInputElement)
      .value;

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setPending(false);

    if (result?.error) {
      setError("Invalid email or password.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 space-y-5">
      <Input
        label="Email"
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />
      <Input
        label="Password"
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        error={error ?? undefined}
      />
      <Button type="submit" disabled={pending} className="w-full" size="lg">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
