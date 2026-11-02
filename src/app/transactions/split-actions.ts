"use server";
import { revalidatePath } from "next/cache";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import {
  createSplit as createSplitForActor,
  deleteSplit as deleteSplitForActor,
  recordSettlement as recordSettlementForActor,
  clearSettlement as clearSettlementForActor,
} from "@/lib/ledger/splits";
import type { ParticipantInput } from "@/lib/ledger/splits";
export type { ParticipantInput } from "@/lib/ledger/splits";

export async function createSplit(input: {
  transactionId: string;
  totalPaise: number;
  yourSharePaise: number;
  note: string | null;
  participants: ParticipantInput[];
  /** Refuse instead of editing when a split already exists (assistant cards). */
  expectNoExistingSplit?: boolean;
}) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const result = await createSplitForActor(
    { actor: { userId: user.id, accountId: account.id }, source: "app" },
    input,
  );
  if (result.revalidate) {
    revalidatePath("/transactions");
    revalidatePath("/reimbursements");
    revalidatePath("/");
  }
}

export async function deleteSplit(input: {
  transactionId: string;
  /** Refuse if any money was settled against the split (assistant Undo). */
  expectNoSettlements?: boolean;
}) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const result = await deleteSplitForActor(
    { actor: { userId: user.id, accountId: account.id }, source: "app" },
    input,
  );
  if (result.revalidate) {
    revalidatePath("/transactions");
    revalidatePath("/reimbursements");
    revalidatePath("/people");
    revalidatePath("/");
  }
}

export async function recordSettlement(input: {
  inflowTransactionId: string;
  allocations: Array<{ splitParticipantId: string; amountPaise: number }>;
  residual?: {
    kind: "owed_back" | "kept" | "written_off";
    personName?: string;
    note?: string | null;
  } | null;
}) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const result = await recordSettlementForActor(
    { actor: { userId: user.id, accountId: account.id }, source: "app" },
    input,
  );
  if (result.revalidate) {
    revalidatePath("/transactions");
    revalidatePath("/reimbursements");
    revalidatePath("/people");
    revalidatePath("/");
  }
}

export async function clearSettlement(input: { inflowTransactionId: string }) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const result = await clearSettlementForActor(
    { actor: { userId: user.id, accountId: account.id }, source: "app" },
    input,
  );
  if (result.revalidate) {
    revalidatePath("/transactions");
    revalidatePath("/reimbursements");
    revalidatePath("/people");
    revalidatePath("/");
  }
}
