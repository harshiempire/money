"use client";

import { useActionState } from "react";
import { registerUser, type RegisterState } from "@/app/auth/actions";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

const initial: RegisterState = {};

export function RegisterForm() {
  const [state, action, pending] = useActionState(registerUser, initial);

  return (
    <form action={action} className="mt-8 space-y-5">
      <Input
        label="Name (optional)"
        id="name"
        name="name"
        type="text"
        autoComplete="name"
      />
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
        autoComplete="new-password"
        required
        minLength={12}
        hint="At least 12 characters"
      />
      <Input
        label="Confirm password"
        id="confirm"
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
        minLength={12}
        error={state.error}
      />
      <Button type="submit" disabled={pending} className="w-full" size="lg">
        {pending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
