"use server";
import { asFormAction, definePublicAction } from "@/lib/action/define-action";
import { registerUserSpec } from "./register-handler";
export type { FormState as RegisterState } from "@/lib/action/result";
export const registerUser = asFormAction(definePublicAction("registerUser", registerUserSpec));
