import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { Schema } from "effect";
import { schema } from "@/db";
import { LedgerError, type WriteContext } from "./context";
import { runChange } from "./store";
import { lockRelationalActor, relationalSnapshot, relationalHelpers } from "./relational-store";
import { snapshotDiff, type Operation } from "./rules";
import { existingPerson, personKey } from "@/lib/mcp/write-rules";

const name = Schema.String.check(Schema.isMaxLength(200), Schema.makeFilter(s => s.trim().length > 0));
const Input = Schema.Array(Schema.Struct({
  counterpartyId: Schema.NonEmptyString,
  person: Schema.NullOr(name), currentPerson: Schema.NullOr(name),
  createPerson: Schema.optionalKey(Schema.Boolean),
  distinctFrom: Schema.optionalKey(Schema.Array(name).check(Schema.isMaxLength(20))),
})).check(Schema.isBetweenLength(1, 50));

/** One guarded batch, including any new people and its durable receipt. */
export async function linkPayeesToPerson(ctx: WriteContext, links: typeof Input.Type) {
  if (!Schema.is(Input)(links) || new Set(links.map(l => l.counterpartyId)).size !== links.length)
    throw new LedgerError({ code: "invalid_input", message: "Use 1–50 distinct payees with current-person guards." });
  if (ctx.source === "mcp" && (!ctx.idempotency || !/^[A-Za-z0-9_-]{8,80}$/.test(ctx.idempotency.key)))
    throw new LedgerError({ code: "invalid_input", message: "Use an 8–80 character idempotency key." });
  const meta = { kind: "link_person", summary: "" };
  return runChange(ctx, meta, async tx => {
    await lockRelationalActor(tx, ctx);
    const before = await relationalSnapshot(tx, ctx, true);
    const helpers = relationalHelpers(tx, ctx, before);
    const p = schema.counterparties;
    const payees = await tx.select().from(p).where(and(eq(p.userId, ctx.actor.userId), inArray(p.id, links.map(l => l.counterpartyId)))).orderBy(p.id).for("update");
    if (payees.length !== links.length)
      throw new LedgerError({ code: "not_found", message: "A payee isn't available in this account." });
    const ops: Operation[] = [], descriptions: string[] = [];
    const names = [...helpers.before.people.map(p => p.name), ...helpers.before.participants.map(p => p.personName), ...helpers.before.owed.map(p => p.personName)];
    for (const link of links) {
      const payee = payees.find(p => p.id === link.counterpartyId)!;
      const current = helpers.before.people.find(p => p.id === payee.personId)?.name ?? null;
      if (payee.personId && current === null)
        throw new LedgerError({ code: "not_found", message: "The linked person is not available." });
      if ((current === null) !== (link.currentPerson === null) || current !== null && personKey(current) !== personKey(link.currentPerson!))
        throw new LedgerError({ code: "stale", message: `The linked person for ${payee.key} changed. Read and confirm current_person again.` });
      const resolved = link.person === null ? null : existingPerson(names, link.person, link.createPerson, link.distinctFrom);
      const personId = resolved === null ? null : await helpers.getOrCreatePerson(ctx.actor.userId, resolved);
      if (resolved && !names.some(name => personKey(name) === personKey(resolved))) names.push(resolved);
      if (personId === payee.personId) continue;
      ops.push({ target: "counterparty_person", id: payee.id, before: { personId: payee.personId }, after: { personId } });
      await tx.update(p).set({ personId }).where(and(eq(p.id, payee.id), eq(p.userId, ctx.actor.userId)));
      descriptions.push(resolved === null ? `Unlinked ${payee.key} from ${current}` : `Linked ${payee.key} to ${resolved}`);
    }
    ops.push(...snapshotDiff(before, await relationalSnapshot(tx, ctx)));
    // The actual operation is visible even when the caller supplies a reason.
    const summary = descriptions.join("; ") || "Person links unchanged";
    meta.summary = (summary + (ctx.summary ? ` — ${ctx.summary}` : "")).slice(0, 200);
    return { ops, result: { changeId: null, ops, summary } };
  });
}
