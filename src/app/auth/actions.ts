"use server";

import { asFormAction, definePublicAction } from "@/lib/action/define-action";
import type { FormState } from "@/lib/action/result";
import { registerUserSpec } from "./register-handler";

// Logic lives in ./register-handler.ts. No session required (public action).
// Shaped for useActionState: (previousState, formData) → { error?, field? }.

export type RegisterState = FormState;

export const registerUser = asFormAction(definePublicAction("registerUser", registerUserSpec));
