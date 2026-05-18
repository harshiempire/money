"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { hashPassword, signIn } from "@/auth";
import { db, schema } from "@/db";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { checkRegisterRateLimit } from "@/lib/rate-limit";
import { AuthError } from "next-auth";

const MIN_PASSWORD_LENGTH = 12;

export type RegisterState = { error?: string };

export async function registerUser(
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const name = String(formData.get("name") ?? "").trim() || null;

  if (!email || !email.includes("@")) {
    return { error: "Enter a valid email address." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password !== confirm) {
    return { error: "Passwords do not match." };
  }

  const hdrs = await headers();
  const ip =
    hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    hdrs.get("x-real-ip") ??
    "unknown";
  if (!(await checkRegisterRateLimit(ip))) {
    return { error: "Too many registration attempts. Try again later." };
  }

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing) {
    return { error: "An account with this email already exists." };
  }

  const passwordHash = await hashPassword(password);
  const [created] = await db
    .insert(schema.users)
    .values({
      email,
      name,
      passwordHash,
      tokenVersion: 0,
    })
    .returning({ id: schema.users.id });

  await ensureDefaultCategories(created.id);

  try {
    await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: "Account created but sign-in failed. Try logging in." };
    }
    throw err;
  }

  redirect("/");
}
