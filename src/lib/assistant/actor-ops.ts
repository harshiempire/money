/**
 * Month tagging and standing notes for one already-authenticated user.
 * Callers (the Ask Money panel, and later an MCP server or CLI) pass a
 * MoneyActor. Nothing here signs a session in or talks to a model.
 */
import "server-only";
import { setPayeeDefault } from "@/lib/ledger/payee-default";
import { LedgerError } from "@/lib/ledger/context";
import { and, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { db, schema } from "@/db";
import { loadCategories } from "@/lib/assistant/data";
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
  return runTagUndo(rows, async (row) => {
    await setCategoryForActor(actor, {
      transactionId: row.transactionId,
      categoryId: row.previousCategoryId ?? "",
      expectedCurrentCategoryId: row.categoryId,
      isTransfer: row.previousIsTransfer,
    });
  });
}

export type RememberPayeeResult =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; confirm: true; existingCategoryId: string; existingCategoryName: string; nextCategoryName: string };

/** Sets the payee's default category only. Other transactions stay as they are. */
export async function rememberPayeeDefaultForActor(
  actor: MoneyActor,
  input: { counterpartyId: string; categoryId: string; confirmFromCategoryId?: string | null },
): Promise<RememberPayeeResult> {
  if (!input.counterpartyId || !input.categoryId) return { ok: false, error: "Pick a payee and a category." };
  const result = await setPayeeDefault({ actor, source: "app" }, {
    counterpartyId: input.counterpartyId, categoryId: input.categoryId,
    guard: { confirmFromCategoryId: input.confirmFromCategoryId ?? null },
  }).catch((err) => {
    if (err instanceof LedgerError && ["not_found", "unknown_category"].includes(err.code)) return null;
    throw err;
  });
  if (!result) return { ok: false, error: "That payee or category isn't available." };
  if (result.confirm && result.currentCategoryId) {
    const ids = [result.currentCategoryId, input.categoryId];
    const names = await db.select({ id: schema.categories.id, name: schema.categories.name }).from(schema.categories)
      .where(and(eq(schema.categories.userId, actor.userId), inArray(schema.categories.id, ids)));
    const nameOf = (id: string) => names.find((row) => row.id === id)?.name ?? "another category";
    return { ok: false, confirm: true, existingCategoryId: result.currentCategoryId,
      existingCategoryName: nameOf(result.currentCategoryId), nextCategoryName: nameOf(input.categoryId) };
  }
  return { ok: true };
}
