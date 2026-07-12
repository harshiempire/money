import "server-only";

import { cache } from "react";
import { requireCurrentUser } from "./require-current-user";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { backfillCounterparties } from "@/db/counterparty-backfill";

/** Per-request cached session user (dedupes layout + page auth). */
export const getCurrentUser = cache(requireCurrentUser);

/** Per-request cached BoB money account for the current user. */
export const getBobAccount = cache(async () => {
  const user = await getCurrentUser();
  return getOrCreateAccountForBank(user.id, "bob");
});

/** Idempotent default categories seed — once per request. */
export const ensureTenantDefaults = cache(async () => {
  const user = await getCurrentUser();
  await ensureDefaultCategories(user.id);
});

/** Idempotent counterparty backfill — once per request. */
export const runCounterpartyBackfill = cache(async () => {
  const user = await getCurrentUser();
  const account = await getBobAccount();
  return backfillCounterparties(account.id, user.id);
});
