/**
 * Month tagging and standing notes for one already-authenticated user.
 * Callers (the Ask Money panel, and later an MCP server or CLI) pass a
 * MoneyActor. Nothing here signs a session in or talks to a model.
 */
import "server-only";
import { and, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { db, schema } from "@/db";
import { loadCategories } from "@/lib/assistant/data";
import { ForbiddenError } from "@/lib/auth/forbidden";
import { assertCategoryOwned, assertCounterpartyOwned } from "@/lib/auth/ownership";
import { setCategoryForActor } from "@/lib/transactions/category-for-actor";
import { runTagApply, runTagUndo, type AppliedTag, type TagApplyRequest, type TagApplyResult, type TagUndoResult } from "./tag-apply";
import {
  assembleTagChunk,
  standingNotesForModel,
  type ContextNote,
  type ModelGuess,
  type TagChunkDraft,
  type TagFact,
  type UntaggedMonth,
} from "./tag-batch";
import type { CategoryLite } from "./types";
import { listUntaggedMonths, loadContextNotes, loadTagFacts, monthBounds } from "./tag-store";

export interface MoneyActor {
  userId: string;
  accountId: string;
}

const NOTE_MAX = 500;
const NOTE_CAP = 40;
const t = schema.transactions;

export interface TagMonthSnapshot {
  untagged: TagFact[];
  past: TagFact[];
  categories: CategoryLite[];
  notes: ContextNote[];
}

/** Uncategorized rows for the month, plus the history and notes used to draft suggestions. */
export async function loadTagMonth(actor: MoneyActor, year: number, month: number): Promise<TagMonthSnapshot> {
  const { from, to } = monthBounds(year, month);
  const [untagged, past, categories, notes] = await Promise.all([
    loadTagFacts(actor.accountId, actor.userId, and(gte(t.txnDate, from), lt(t.txnDate, to), isNull(t.categoryId))),
    loadTagFacts(actor.accountId, actor.userId, isNotNull(t.categoryId)),
    loadCategories(actor.userId),
    loadContextNotes(actor.userId),
  ]);
  return { untagged, past, categories, notes };
}

/** One chunk of the suggestion draft. `guesses` are an optional input. This does not call a model. */
export function draftTagChunk(
  snapshot: TagMonthSnapshot,
  input: { year: number; month: number; offset: number; guesses?: ModelGuess[] },
): TagChunkDraft {
  return assembleTagChunk({
    untagged: snapshot.untagged,
    past: snapshot.past,
    categories: snapshot.categories,
    year: input.year,
    month: input.month,
    offset: input.offset,
    guesses: input.guesses,
  });
}

export async function listUntaggedMonthsForActor(actor: MoneyActor): Promise<UntaggedMonth[]> {
  return listUntaggedMonths(actor.accountId);
}

export async function readStandingNotes(actor: MoneyActor): Promise<ContextNote[]> {
  return loadContextNotes(actor.userId);
}

export async function notesForModel(actor: MoneyActor): Promise<string[]> {
  const notes = await readStandingNotes(actor);
  return standingNotesForModel(notes.map((note) => note.body));
}

export async function saveStandingNote(
  actor: MoneyActor,
  input: { id?: string; body: string },
): Promise<{ ok: true; note: ContextNote } | { ok: false; error: string }> {
  const body = input.body.trim().slice(0, NOTE_MAX);
  if (!body) return { ok: false, error: "Write a note first." };
  const id = input.id ?? "";
  if (id) {
    const [updated] = await db
      .update(schema.assistantContextNotes)
      .set({ body, updatedAt: new Date() })
      .where(and(eq(schema.assistantContextNotes.id, id), eq(schema.assistantContextNotes.userId, actor.userId)))
      .returning({ id: schema.assistantContextNotes.id, body: schema.assistantContextNotes.body });
    if (!updated) return { ok: false, error: "That note isn't available." };
    return { ok: true, note: updated };
  }
  const existing = await loadContextNotes(actor.userId);
  if (existing.length >= NOTE_CAP) return { ok: false, error: `Notes are limited to ${NOTE_CAP}.` };
  const [created] = await db
    .insert(schema.assistantContextNotes)
    .values({ userId: actor.userId, body })
    .returning({ id: schema.assistantContextNotes.id, body: schema.assistantContextNotes.body });
  return { ok: true, note: created };
}

export async function deleteStandingNote(actor: MoneyActor, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!id) return { ok: false, error: "That note isn't available." };
  await db
    .delete(schema.assistantContextNotes)
    .where(and(eq(schema.assistantContextNotes.id, id), eq(schema.assistantContextNotes.userId, actor.userId)));
  return { ok: true };
}

export async function applyTagDraft(actor: MoneyActor, rows: TagApplyRequest[]): Promise<TagApplyResult> {
  return runTagApply(rows, (row) =>
    setCategoryForActor(actor, {
      transactionId: row.transactionId,
      categoryId: row.categoryId,
      expectedCurrentCategoryId: row.expectedCurrentCategoryId,
    }),
  );
}

export async function undoTagDraft(actor: MoneyActor, rows: AppliedTag[]): Promise<TagUndoResult> {
  return runTagUndo(rows, (row) =>
    setCategoryForActor(actor, {
      transactionId: row.transactionId,
      categoryId: row.previousCategoryId ?? "",
      expectedCurrentCategoryId: row.categoryId,
    }),
  );
}

/** Sets the payee's default category only. Other transactions stay as they are. */
export async function rememberPayeeDefaultForActor(
  actor: MoneyActor,
  input: { counterpartyId: string; categoryId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.counterpartyId || !input.categoryId) return { ok: false, error: "Pick a payee and a category." };
  try {
    await assertCounterpartyOwned(actor.userId, input.counterpartyId);
    await assertCategoryOwned(actor.userId, input.categoryId);
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: "That payee or category isn't available." };
    throw err;
  }
  await db
    .update(schema.counterparties)
    .set({ defaultCategoryId: input.categoryId })
    .where(and(eq(schema.counterparties.id, input.counterpartyId), eq(schema.counterparties.userId, actor.userId)));
  return { ok: true };
}
