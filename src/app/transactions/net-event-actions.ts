"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { getOrCreatePerson } from "@/db/person";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import {
  assertCategoryOwned,
  assertNetEventOwned,
  assertOwedExpenseOwned,
  assertSplitParticipantOwned,
  assertTransactionOwned,
} from "@/lib/auth/ownership";
import { NetEventValidationError } from "@/lib/net-events/errors";
import {
  owedExpenseOutstanding,
  participantOutstanding,
} from "@/lib/splits/outstanding";
import { validateNetEventInvariant } from "@/lib/net-events/validate";

export type NewPayableSpec = {
  personName: string;
  incurredDate: string;
  amountPaise: number;
  description: string;
  categoryId?: string | null;
  note?: string | null;
};

export type NetEventLeg =
  | {
      kind: "receivable";
      splitParticipantId: string;
      amountPaise: number;
      method: "bank" | "offset";
    }
  | ({
      kind: "payable";
      amountPaise: number;
      method: "offset";
    } & (
      | { owedExpenseId: string; newPayable?: never }
      | { owedExpenseId?: never; newPayable: NewPayableSpec }
    ));

const safePaise = (n: number): number =>
  Number.isFinite(n) ? Math.round(n) : 0;

const revalidateAll = () => {
  revalidatePath("/transactions");
  revalidatePath("/reimbursements");
  revalidatePath("/people");
  revalidatePath("/spend");
  revalidatePath("/");
};

async function fetchTransactionAmount(
  userId: string,
  transactionId: string,
): Promise<number> {
  await assertTransactionOwned(userId, transactionId);
  const [row] = await db
    .select({ amountPaise: schema.transactions.amountPaise })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, transactionId))
    .limit(1);
  if (!row) {
    throw new NetEventValidationError("MISSING_BANK_TXN", "Transaction not found");
  }
  return Number(row.amountPaise);
}

export async function saveNetEvent(input: {
  netEventId?: string;
  eventDate: string;
  inflowTransactionId?: string;
  outflowTransactionId?: string;
  note?: string;
  legs: NetEventLeg[];
}) {
  const user = await requireCurrentUserAction();

  const cleanLegs = input.legs
    .map((leg) => ({
      ...leg,
      amountPaise: safePaise(leg.amountPaise),
    }))
    .filter((leg) => leg.amountPaise > 0);

  if (cleanLegs.length === 0) {
    throw new NetEventValidationError(
      "INVALID_LEG",
      "At least one non-zero leg is required",
    );
  }

  // Sync validation first (no DB), then fan out ownership / outstanding checks.
  for (const leg of cleanLegs) {
    if (leg.kind === "receivable") {
      if (leg.method === "bank" && !input.inflowTransactionId) {
        throw new NetEventValidationError(
          "MISSING_BANK_TXN",
          "Bank receivable legs require an inflow transaction",
        );
      }
    } else if (leg.owedExpenseId) {
      if (leg.method !== "offset") {
        throw new NetEventValidationError(
          "INVALID_LEG",
          "Payable legs must use offset method",
        );
      }
    } else if (leg.newPayable) {
      if (leg.method !== "offset") {
        throw new NetEventValidationError(
          "INVALID_LEG",
          "Payable legs must use offset method",
        );
      }
      const description = leg.newPayable.description.trim();
      if (!description) {
        throw new NetEventValidationError(
          "INVALID_LEG",
          "New payable description is required",
        );
      }
      if (leg.newPayable.amountPaise <= 0) {
        throw new NetEventValidationError(
          "INVALID_LEG",
          "New payable amount must be positive",
        );
      }
      if (leg.amountPaise > leg.newPayable.amountPaise) {
        throw new NetEventValidationError(
          "OVER_ALLOCATION",
          `Payable leg exceeds new expense amount by ${(leg.amountPaise - leg.newPayable.amountPaise) / 100}`,
        );
      }
    } else {
      throw new NetEventValidationError(
        "INVALID_LEG",
        "Payable leg requires owedExpenseId or newPayable",
      );
    }
  }

  const ownershipChecks: Promise<unknown>[] = [];
  if (input.inflowTransactionId) {
    ownershipChecks.push(
      assertTransactionOwned(user.id, input.inflowTransactionId),
    );
  }
  if (input.outflowTransactionId) {
    ownershipChecks.push(
      assertTransactionOwned(user.id, input.outflowTransactionId),
    );
  }
  if (input.netEventId) {
    ownershipChecks.push(assertNetEventOwned(user.id, input.netEventId));
  }
  for (const leg of cleanLegs) {
    if (leg.kind === "receivable") {
      ownershipChecks.push(
        assertSplitParticipantOwned(user.id, leg.splitParticipantId),
      );
    } else if (leg.owedExpenseId) {
      ownershipChecks.push(assertOwedExpenseOwned(user.id, leg.owedExpenseId));
    } else if (leg.newPayable?.categoryId) {
      ownershipChecks.push(
        assertCategoryOwned(user.id, leg.newPayable.categoryId),
      );
    }
  }
  await Promise.all(ownershipChecks);

  const [inflowAmount, outflowAmount] = await Promise.all([
    input.inflowTransactionId
      ? fetchTransactionAmount(user.id, input.inflowTransactionId)
      : Promise.resolve(0),
    input.outflowTransactionId
      ? fetchTransactionAmount(user.id, input.outflowTransactionId)
      : Promise.resolve(0),
  ]);

  const invariant = validateNetEventInvariant(
    cleanLegs,
    inflowAmount,
    outflowAmount,
  );
  if (!invariant.ok) {
    throw new NetEventValidationError("INVARIANT_MISMATCH", invariant.message);
  }

  await Promise.all(
    cleanLegs.map(async (leg) => {
      if (leg.kind === "receivable") {
        const outstanding = await participantOutstanding(
          leg.splitParticipantId,
          input.netEventId,
        );
        if (leg.amountPaise > outstanding) {
          throw new NetEventValidationError(
            "OVER_ALLOCATION",
            `Receivable leg exceeds outstanding by ${(leg.amountPaise - outstanding) / 100}`,
          );
        }
      } else if (leg.owedExpenseId) {
        const outstanding = await owedExpenseOutstanding(
          leg.owedExpenseId,
          input.netEventId,
        );
        if (leg.amountPaise > outstanding) {
          throw new NetEventValidationError(
            "OVER_ALLOCATION",
            `Payable leg exceeds outstanding by ${(leg.amountPaise - outstanding) / 100}`,
          );
        }
      }
    }),
  );

  try {
  await db.transaction(async (tx) => {
    if (input.netEventId) {
      await tx
        .delete(schema.settlements)
        .where(eq(schema.settlements.netEventId, input.netEventId));
      await tx
        .delete(schema.netEvents)
        .where(eq(schema.netEvents.id, input.netEventId));
    }

    const [event] = await tx
      .insert(schema.netEvents)
      .values({
        userId: user.id,
        eventDate: input.eventDate,
        inflowTransactionId: input.inflowTransactionId ?? null,
        outflowTransactionId: input.outflowTransactionId ?? null,
        note: input.note?.trim() ? input.note.trim().slice(0, 200) : null,
      })
      .returning({ id: schema.netEvents.id });

    const settlementRows = [];
    for (const leg of cleanLegs) {
      if (leg.kind === "receivable") {
        settlementRows.push({
          netEventId: event.id,
          splitParticipantId: leg.splitParticipantId,
          owedExpenseId: null,
          amountPaise: leg.amountPaise,
          method: leg.method,
          inflowTransactionId:
            leg.method === "bank" ? (input.inflowTransactionId ?? null) : null,
        });
        continue;
      }

      let owedExpenseId = leg.owedExpenseId;
      if (leg.newPayable) {
        const personId = await getOrCreatePerson(
          user.id,
          leg.newPayable.personName,
          tx,
        );
        const [created] = await tx
          .insert(schema.owedExpenses)
          .values({
            userId: user.id,
            personId,
            personName: leg.newPayable.personName.trim(),
            incurredDate: leg.newPayable.incurredDate,
            amountPaise: leg.newPayable.amountPaise,
            description: leg.newPayable.description.trim(),
            categoryId: leg.newPayable.categoryId ?? null,
            note: leg.newPayable.note?.trim()
              ? leg.newPayable.note.trim().slice(0, 200)
              : null,
          })
          .returning({ id: schema.owedExpenses.id });
        owedExpenseId = created.id;
      }

      settlementRows.push({
        netEventId: event.id,
        splitParticipantId: null,
        owedExpenseId,
        amountPaise: leg.amountPaise,
        method: "offset" as const,
        inflowTransactionId: null,
      });
    }

    await tx.insert(schema.settlements).values(settlementRows);
  });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/timeout|terminat|connect/i.test(msg)) {
      throw new Error(
        "Database connection timed out while saving. Please try again in a moment.",
      );
    }
    throw err;
  }

  revalidateAll();
}

export async function deleteNetEvent(input: { netEventId: string }) {
  const user = await requireCurrentUserAction();
  await assertNetEventOwned(user.id, input.netEventId);

  try {
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.settlements)
        .where(eq(schema.settlements.netEventId, input.netEventId));
      await tx
        .delete(schema.netEvents)
        .where(eq(schema.netEvents.id, input.netEventId));
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/timeout|terminat|connect/i.test(msg)) {
      throw new Error(
        "Database connection timed out while reversing. Please try again.",
      );
    }
    throw err;
  }

  revalidateAll();
}
