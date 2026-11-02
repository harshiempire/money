import "server-only";
import { and, eq } from "drizzle-orm";
import { Schema } from "effect";
import { schema } from "@/db";
import { LedgerError, type WriteContext } from "./context";
import { runChange } from "./store";
const Input = Schema.Struct({
  counterpartyId: Schema.NonEmptyString,
  categoryId: Schema.NullOr(Schema.String),
  guard: Schema.Union([
    Schema.Struct({ currentDefaultCategoryId: Schema.NullOr(Schema.String) }),
    Schema.Struct({ confirmFromCategoryId: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ]),
});
export type PayeeResult = {
  changeId: string | null;
  currentCategoryId: string | null;
  confirm?: true;
  replayed?: boolean;
  response?: Record<string, unknown>;
};
export async function setPayeeDefault(ctx: WriteContext, input: typeof Input.Type): Promise<PayeeResult> {
  if (!Schema.is(Input)(input))
    throw new LedgerError({ code: "invalid_input", message: "Pick a payee and a category." });
  return runChange<PayeeResult>(ctx, { kind: "payee_default" }, async (tx) => {
    const p = schema.counterparties;
    const [payee] = await tx
      .select()
      .from(p)
      .where(and(eq(p.id, input.counterpartyId), eq(p.userId, ctx.actor.userId)))
      .for("update");
    if (!payee)
      throw new LedgerError({ code: "not_found", message: "That payee or category isn't available." });
    if (input.categoryId) {
      const [cat] = await tx
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(
          and(eq(schema.categories.id, input.categoryId), eq(schema.categories.userId, ctx.actor.userId)),
        );
      if (!cat)
        throw new LedgerError({
          code: "unknown_category",
          message: "That payee or category isn't available.",
        });
    }
    const current = payee.defaultCategoryId;
    const strict = "currentDefaultCategoryId" in input.guard;
    const expected = strict ? input.guard.currentDefaultCategoryId : input.guard.confirmFromCategoryId;
    if (
      (strict && current !== expected) ||
      (!strict && current && current !== input.categoryId && current !== expected)
    ) {
      return {
        ops: [],
        refused: true,
        result: { changeId: null, currentCategoryId: current, confirm: true as const },
      };
    }
    const before = { defaultCategoryId: current },
      after = { defaultCategoryId: input.categoryId };
    const ops =
      current === input.categoryId ? [] : [{ target: "counterparty" as const, id: payee.id, before, after }];
    if (ops.length)
      await tx
        .update(p)
        .set(after)
        .where(and(eq(p.id, payee.id), eq(p.userId, ctx.actor.userId)));
    return { ops, result: { changeId: null, currentCategoryId: input.categoryId } };
  });
}
