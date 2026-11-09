import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { schema } from "@/db";
import { isMissingTable } from "@/lib/db/pg-errors";
import { LedgerError, type WriteContext } from "./context";
import { ledgerQuery, lockRelationalActor } from "./relational-store";
import { STANDING_NOTE_CAP, STANDING_NOTE_MAX, type Operation } from "./rules";
import { runChangeEffect, type LedgerTx } from "./store";

const n = schema.assistantContextNotes;
// Timestamp text keeps PostgreSQL's sub-millisecond precision for undo's compare.
const noteRow = {
  id: n.id, userId: n.userId, body: n.body,
  createdAt: sql<string>`${n.createdAt}::text`, updatedAt: sql<string>`${n.updatedAt}::text`,
};
type NoteRow = { id: string; userId: string; body: string; createdAt: string; updatedAt: string };
type Saved = { changeId: string | null; ops: Operation[]; note: { id: string; body: string } };
type Removed = { changeId: string | null; ops: Operation[] };

const Body = Schema.String.check(Schema.isMaxLength(STANDING_NOTE_MAX), Schema.makeFilter(s => s.trim().length > 0));
const checkBody = (body: string) => Schema.is(Body)(body)
  ? Effect.void
  : Effect.fail(new LedgerError({ code: "invalid_input", message: `Use a nonblank note of at most ${STANDING_NOTE_MAX} characters.` }));

const withoutId = ({ id: _id, ...fields }: NoteRow) => fields;

/** Every note write holds the actor lock, so the cap and row checks cannot race. */
function noteChange<R extends { changeId: string | null }>(
  ctx: WriteContext,
  kind: string,
  summary: string,
  work: (tx: LedgerTx) => Effect.Effect<{ ops: Operation[]; result: R }, LedgerError>,
) {
  return runChangeEffect(ctx, { kind, summary: ctx.summary ?? summary }, tx => Effect.gen(function* () {
    yield* ledgerQuery(() => lockRelationalActor(tx, ctx));
    return yield* work(tx);
  })).pipe(Effect.catchDefect(defect => isMissingTable(defect)
    ? Effect.fail(new LedgerError({ code: "migration_required", message: "Notes aren't available until migration 0012 is applied." }))
    : Effect.die(defect)));
}

const lockNote = (tx: LedgerTx, ctx: WriteContext, id: string) =>
  ledgerQuery(() => tx.select(noteRow).from(n).where(and(eq(n.id, id), eq(n.userId, ctx.actor.userId))).for("update"));

export const addStandingNote = Effect.fn("addStandingNote")(function* (ctx: WriteContext, body: string) {
  yield* checkBody(body);
  return yield* noteChange<Saved>(ctx, "add_standing_note", "Added standing note", tx => Effect.gen(function* () {
    const rows = yield* ledgerQuery(() => tx.select({ id: n.id }).from(n).where(eq(n.userId, ctx.actor.userId)).for("update"));
    if (rows.length >= STANDING_NOTE_CAP) return yield* new LedgerError({ code: "limit_reached", message: `Notes are limited to ${STANDING_NOTE_CAP}.` });
    const [created] = yield* ledgerQuery(() => tx.insert(n).values({ userId: ctx.actor.userId, body: body.trim() }).returning(noteRow));
    const ops: Operation[] = [{ target: "standing_note", id: created.id, before: null, after: withoutId(created) }];
    return { ops, result: { changeId: null, ops, note: { id: created.id, body: created.body } } };
  }));
});

export const updateStandingNote = Effect.fn("updateStandingNote")(function* (ctx: WriteContext, input: { id: string; body: string }) {
  yield* checkBody(input.body);
  const body = input.body.trim();
  return yield* noteChange<Saved>(ctx, "update_standing_note", "Edited standing note", tx => Effect.gen(function* () {
    const [row] = yield* lockNote(tx, ctx, input.id);
    if (!row) return yield* new LedgerError({ code: "not_found", message: "That note isn't available." });
    const note = { id: row.id, body };
    if (row.body === body) return { ops: [], result: { changeId: null, ops: [], note } };
    const [updated] = yield* ledgerQuery(() => tx.update(n).set({ body, updatedAt: new Date() }).where(eq(n.id, row.id)).returning(noteRow));
    const ops: Operation[] = [{ target: "standing_note", id: row.id, before: withoutId(row), after: withoutId(updated) }];
    return { ops, result: { changeId: null, ops, note } };
  }));
});

/** A note that is missing or belongs to someone else is a quiet no-op, as the app has always treated it. */
export const deleteStandingNote = Effect.fn("deleteStandingNote")(function* (ctx: WriteContext, id: string) {
  return yield* noteChange<Removed>(ctx, "delete_standing_note", "Deleted standing note", tx => Effect.gen(function* () {
    const [row] = yield* lockNote(tx, ctx, id);
    if (!row) return { ops: [], result: { changeId: null, ops: [] } };
    yield* ledgerQuery(() => tx.delete(n).where(eq(n.id, row.id)));
    const ops: Operation[] = [{ target: "standing_note", id: row.id, before: withoutId(row), after: null }];
    return { ops, result: { changeId: null, ops } };
  }));
});
