"use server";
import { revalidatePath } from "next/cache";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import {
  saveNetEvent as saveNetEventForActor,
  deleteNetEvent as deleteNetEventForActor,
} from "@/lib/ledger/net-events";
import type { NetEventLeg } from "@/lib/ledger/net-events";
export type { NewPayableSpec, NetEventLeg } from "@/lib/ledger/net-events";

export async function saveNetEvent(input: {
  netEventId?: string;
  eventDate: string;
  inflowTransactionId?: string;
  outflowTransactionId?: string;
  note?: string;
  legs: NetEventLeg[];
}) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const result = await saveNetEventForActor(
    { actor: { userId: user.id, accountId: account.id }, source: "app" },
    input,
  );
  if (result.revalidate) {
    revalidatePath("/transactions");
    revalidatePath("/reimbursements");
    revalidatePath("/people");
    revalidatePath("/spend");
    revalidatePath("/");
  }
  return result.value!;
}

export async function deleteNetEvent(input: { netEventId: string }) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const result = await deleteNetEventForActor(
    { actor: { userId: user.id, accountId: account.id }, source: "app" },
    input,
  );
  if (result.revalidate) {
    revalidatePath("/transactions");
    revalidatePath("/reimbursements");
    revalidatePath("/people");
    revalidatePath("/spend");
    revalidatePath("/");
  }
}
