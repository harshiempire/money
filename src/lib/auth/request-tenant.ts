import "server-only";

import { cache } from "react";
import { requireCurrentUser } from "./require-current-user";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { ensureDefaultCategories } from "@/db/seed-categories";
import { backfillCounterparties } from "@/db/counterparty-backfill";

export const getCurrentUser = cache(requireCurrentUser);

export const getBobAccount = cache(async () => {
  const user = await getCurrentUser();
  return getOrCreateAccountForBank(user.id, "bob");
});

export const ensureTenantDefaults = cache(async () => {
  const user = await getCurrentUser();
  await ensureDefaultCategories(user.id);
});

export const runCounterpartyBackfill = cache(async () => {
  const user = await getCurrentUser();
  const account = await getBobAccount();
  return backfillCounterparties(account.id, user.id);
});
