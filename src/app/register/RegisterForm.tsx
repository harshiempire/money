"use client";

import { useActionState } from "react";
import { registerUser, type RegisterState } from "@/app/auth/actions";

const initial: RegisterState = {};

export function RegisterForm() {
  const [state, action, pending] = useActionState(registerUser, initial);

  return (
    <form action={action} className="mt-6 space-y-4">
      <div>
        <label htmlFor="name" className="block text-sm font-medium">
          Name (optional)
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          className="mt-1 w-full rounded-md border border-border-default bg-surface-raised px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label htmlFor="email" className="block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="mt-1 w-full rounded-md border border-border-default bg-surface-raised px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          className="mt-1 w-full rounded-md border border-border-default bg-surface-raised px-3 py-2 text-sm"
        />
        <p className="mt-1 text-xs text-neutral-500">At least 12 characters</p>
      </div>
      <div>
        <label htmlFor="confirm" className="block text-sm font-medium">
          Confirm password
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          className="mt-1 w-full rounded-md border border-border-default bg-surface-raised px-3 py-2 text-sm"
        />
      </div>
      {state.error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
