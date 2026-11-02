"use server";
import { revalidatePath } from "next/cache";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import {
  recordCashSettlement as recordCashSettlementForActor,
  deleteCashSettlement as deleteCashSettlementForActor,
  writeOffParticipantShare as writeOffParticipantShareForActor,
  undoWriteOff as undoWriteOffForActor,
} from "@/lib/ledger/settlements";

export async function recordCashSettlement(input: {
  splitParticipantId: string;
  amountPaise: number;
  note: string | null;
}) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const result = await recordCashSettlementForActor(
    { actor: { userId: user.id, accountId: account.id }, source: "app" },
    input,
  );
  if (result.revalidate) {
    revalidatePath("/reimbursements");
    revalidatePath("/transactions");
    revalidatePath("/");
  }
}

export async function deleteCashSettlement(input: { settlementId: string }) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const result = await deleteCashSettlementForActor(
    { actor: { userId: user.id, accountId: account.id }, source: "app" },
    input,
  );
  if (result.revalidate) {
    revalidatePath("/reimbursements");
    revalidatePath("/transactions");
    revalidatePath("/");
  }
}

export async function writeOffParticipantShare(input: { splitParticipantId: string; note: string | null }) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const result = await writeOffParticipantShareForActor(
    { actor: { userId: user.id, accountId: account.id }, source: "app" },
    input,
  );
  if (result.revalidate) {
    revalidatePath("/reimbursements");
    revalidatePath("/transactions");
    revalidatePath("/people");
    revalidatePath("/");
  }
}

export async function undoWriteOff(input: { settlementId: string }) {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const result = await undoWriteOffForActor(
    { actor: { userId: user.id, accountId: account.id }, source: "app" },
    input,
  );
  if (result.revalidate) {
    revalidatePath("/reimbursements");
    revalidatePath("/transactions");
    revalidatePath("/people");
    revalidatePath("/");
  }
}
