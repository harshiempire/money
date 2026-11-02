import "server-only";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { schema } from "@/db";
import { getOrCreatePerson } from "@/db/person";
import type { ActionSpec } from "@/lib/action/core";
import { Invalid } from "@/lib/action/errors";
import { owns } from "@/lib/action/ownership";
import { CurrentUser, query, type Db } from "@/lib/action/services";

/**
 * Owed-expense (money you owe someone) handlers behind
 * ./owed-expense-actions.ts. No UI calls these yet (2026-11-02); they are
 * migrated so they are safe the moment one does.
 *
 * Translated one statement at a time from the pre-Effect implementations:
 * same checks, order and messages. Note the existing order in update: the
 * person is resolved (and created if new) before the amount/description
 * checks, so a rejected update can still leave a new person row.
 */

const ALL_PATHS = ["/reimbursements", "/transactions", "/people", "/spend", "/"] as const;

const safePaise = (n: number): number =>
  Number.isFinite(n) ? Math.round(n) : 0;

// ─── createOwedExpense ───────────────────────────────────────────────────────

const CreateInput = Schema.Struct({
  personName: Schema.String,
  incurredDate: Schema.String,
  amountPaise: Schema.Number,
  description: Schema.String,
  categoryId: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.optional(Schema.NullOr(Schema.String)),
});

/** Resolves to the new owed expense's id. */
export const createOwedExpenseSpec: ActionSpec<
  typeof CreateInput.Type,
  typeof CreateInput.Encoded,
  string,
  CurrentUser | Db
> = {
  input: CreateInput,
  revalidate: ALL_PATHS,
  handler: Effect.fn("createOwedExpense")(function* (input) {
    const user = yield* CurrentUser;
    const amountPaise = safePaise(input.amountPaise);
    if (amountPaise <= 0) {
      return yield* new Invalid({ message: "Amount must be positive" });
    }

    const description = input.description.trim();
    if (!description) {
      return yield* new Invalid({ message: "Description is required" });
    }

    if (input.categoryId) {
      yield* owns.category(input.categoryId);
    }

    // Exactly where getOrCreatePerson would throw this, so nothing else moves;
    // as a typed error the message reaches the user instead of a generic one.
    if (!input.personName.trim()) {
      return yield* new Invalid({ message: "Person name must not be empty" });
    }
    const personId = yield* Effect.promise(() =>
      getOrCreatePerson(user.id, input.personName),
    );

    const [created] = yield* query((db) =>
      db
        .insert(schema.owedExpenses)
        .values({
          userId: user.id,
          personId,
          personName: input.personName.trim(),
          incurredDate: input.incurredDate,
          amountPaise,
          description,
          categoryId: input.categoryId ?? null,
          note: input.note?.trim() ? input.note.trim().slice(0, 200) : null,
        })
        .returning({ id: schema.owedExpenses.id }),
    );

    return created.id;
  }),
};

// ─── updateOwedExpense ───────────────────────────────────────────────────────

const UpdateInput = Schema.Struct({
  id: Schema.String,
  personName: Schema.optional(Schema.String),
  incurredDate: Schema.optional(Schema.String),
  amountPaise: Schema.optional(Schema.Number),
  description: Schema.optional(Schema.String),
  categoryId: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.optional(Schema.NullOr(Schema.String)),
});

export const updateOwedExpenseSpec: ActionSpec<
  typeof UpdateInput.Type,
  typeof UpdateInput.Encoded,
  void,
  CurrentUser | Db
> = {
  input: UpdateInput,
  revalidate: ALL_PATHS,
  handler: Effect.fn("updateOwedExpense")(function* (input) {
    const user = yield* CurrentUser;
    yield* owns.owedExpense(input.id);

    const updates: Partial<typeof schema.owedExpenses.$inferInsert> = {};

    if (input.personName !== undefined) {
      const personName = input.personName;
      if (!personName.trim()) {
        return yield* new Invalid({ message: "Person name must not be empty" });
      }
      const personId = yield* Effect.promise(() =>
        getOrCreatePerson(user.id, personName),
      );
      updates.personId = personId;
      updates.personName = personName.trim();
    }
    if (input.incurredDate !== undefined) {
      updates.incurredDate = input.incurredDate;
    }
    if (input.amountPaise !== undefined) {
      const amountPaise = safePaise(input.amountPaise);
      if (amountPaise <= 0) return yield* new Invalid({ message: "Amount must be positive" });
      updates.amountPaise = amountPaise;
    }
    if (input.description !== undefined) {
      const description = input.description.trim();
      if (!description) return yield* new Invalid({ message: "Description is required" });
      updates.description = description;
    }
    if (input.categoryId !== undefined) {
      if (input.categoryId) {
        yield* owns.category(input.categoryId);
      }
      updates.categoryId = input.categoryId;
    }
    if (input.note !== undefined) {
      updates.note = input.note?.trim() ? input.note.trim().slice(0, 200) : null;
    }

    if (Object.keys(updates).length === 0) return;

    yield* query((db) =>
      db
        .update(schema.owedExpenses)
        .set(updates)
        .where(eq(schema.owedExpenses.id, input.id)),
    );
  }),
};

// ─── deleteOwedExpense ───────────────────────────────────────────────────────

const OwedExpenseRef = Schema.Struct({ id: Schema.String });

export const deleteOwedExpenseSpec: ActionSpec<
  typeof OwedExpenseRef.Type,
  typeof OwedExpenseRef.Encoded,
  void,
  CurrentUser | Db
> = {
  input: OwedExpenseRef,
  revalidate: ALL_PATHS,
  handler: Effect.fn("deleteOwedExpense")(function* (input) {
    yield* owns.owedExpense(input.id);

    yield* query((db) =>
      db.delete(schema.owedExpenses).where(eq(schema.owedExpenses.id, input.id)),
    );
  }),
};
