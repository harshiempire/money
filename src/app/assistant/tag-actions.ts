"use server";

import { revalidatePath } from "next/cache";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import { assistantModel, isAiAllowed } from "@/lib/ai/access";
import { getChatgptAccess } from "@/lib/ai/chatgpt/token-store";
import { checkAssistantRateLimit } from "@/lib/rate-limit";
import {
  applyTagDraft,
  deleteStandingNote,
  draftTagChunk,
  loadTagMonth,
  readStandingNotes,
  rememberPayeeDefaultForActor,
  saveStandingNote,
  undoTagDraft,
  type MoneyActor,
} from "@/lib/assistant/actor-ops";
import { loadTxnCards } from "@/lib/assistant/data";
import { TAG_APPLY_CHUNK, type AppliedTag, type TagApplyRequest } from "@/lib/assistant/tag-apply";
import { monthTitle, standingNotesForModel, type ContextNote, type ModelGuess, type TagDraftRow } from "@/lib/assistant/tag-batch";
import { suggestTagNames } from "@/lib/assistant/tag-suggest";
import type { CategoryLite, TxnCardData } from "@/lib/assistant/types";

async function actorFromSession(): Promise<MoneyActor> {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  return { userId: user.id, accountId: account.id };
}

export async function listContextNotesAction(): Promise<ContextNote[]> {
  return readStandingNotes(await actorFromSession());
}

export async function saveContextNote(input: { id?: string; body: string }) {
  const actor = await actorFromSession();
  const body = typeof input?.body === "string" ? input.body : "";
  const id = typeof input?.id === "string" ? input.id : undefined;
  return saveStandingNote(actor, { id, body });
}

export async function deleteContextNote(input: { id: string }) {
  const actor = await actorFromSession();
  const id = typeof input?.id === "string" ? input.id : "";
  return deleteStandingNote(actor, id);
}

/** The pending-card Apply for a note the model proposed. */
export async function addContextNote(input: { body: string }): Promise<{ id: string }> {
  const saved = await saveContextNote({ body: input.body });
  if (!saved.ok) throw new Error(saved.error);
  return { id: saved.note.id };
}

function validPeriod(year: unknown, month: unknown): { year: number; month: number } | null {
  if (typeof year !== "number" || typeof month !== "number") return null;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function stubEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.MONEY_TAG_SUGGEST_STUB === "1";
}

function stubGuesses(rows: { ref: string }[], categories: CategoryLite[]): ModelGuess[] {
  const cycle = ["high", "medium", "low", "none"] as const;
  return rows.map((row, i) => {
    const confidence = cycle[i % cycle.length];
    if (confidence === "none") return { ref: row.ref, categoryName: null, confidence, reason: "" };
    return {
      ref: row.ref,
      categoryName: categories[i % Math.max(categories.length, 1)]?.name ?? null,
      confidence,
      reason: "Suggested from the amount, channel and payee",
    };
  });
}

interface TagChunkResult {
  ok: true;
  label: string;
  total: number;
  nextOffset: number | null;
  rows: TagDraftRow[];
  txns: TxnCardData[];
  suggester: "model" | "history" | "stub";
}

export async function suggestTagChunk(input: {
  year: number;
  month: number;
  offset: number;
}): Promise<TagChunkResult | { ok: false; error: string }> {
  const period = validPeriod(input?.year, input?.month);
  if (!period) return { ok: false, error: "Pick a month to tag." };
  const offset = typeof input?.offset === "number" && Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
  const actor = await actorFromSession();
  if (!(await checkAssistantRateLimit(actor.userId))) {
    return { ok: false, error: "Too many requests in a short time. Try again in a few minutes." };
  }

  const snapshot = await loadTagMonth(actor, period.year, period.month);
  const open = draftTagChunk(snapshot, { ...period, offset });
  let suggester: TagChunkResult["suggester"] = "history";
  let done = open;
  if (open.needsModel.length > 0) {
    let guesses: ModelGuess[] = [];
    if (stubEnabled()) {
      suggester = "stub";
      guesses = stubGuesses(open.needsModel, snapshot.categories);
    } else if (isAiAllowed(actor.userId)) {
      const access = await getChatgptAccess(actor.userId);
      if (access.ok) {
        const suggested = await suggestTagNames({
          accessToken: access.accessToken,
          accountId: access.accountId,
          model: assistantModel(),
          categories: snapshot.categories.map((c) => c.name),
          standingNotes: standingNotesForModel(snapshot.notes.map((note) => note.body)),
          rows: open.needsModel,
        });
        suggester = suggested.failure ? "history" : "model";
        guesses = suggested.guesses;
      }
    }
    if (guesses.length > 0) done = draftTagChunk(snapshot, { ...period, offset, guesses });
  }

  const txns = await loadTxnCards(actor.accountId, actor.userId, done.rows.map((row) => row.txnId));
  return {
    ok: true,
    label: monthTitle(period.year, period.month),
    total: done.total,
    nextOffset: done.nextOffset,
    rows: done.rows,
    txns,
    suggester,
  };
}

function cleanApplyRows(raw: unknown): { rows: TagApplyRequest[]; overflow: TagApplyRequest[] } {
  if (!Array.isArray(raw)) return { rows: [], overflow: [] };
  const out: TagApplyRequest[] = [];
  for (const item of raw.slice(0, 400)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.transactionId !== "string" || typeof rec.categoryId !== "string") continue;
    const expected = rec.expectedCurrentCategoryId;
    out.push({
      transactionId: rec.transactionId,
      categoryId: rec.categoryId,
      expectedCurrentCategoryId: typeof expected === "string" ? expected : null,
    });
  }
  return { rows: out.slice(0, TAG_APPLY_CHUNK), overflow: out.slice(TAG_APPLY_CHUNK) };
}

export async function applySuggestedTags(input: { rows: TagApplyRequest[] }): Promise<{
  applied: AppliedTag[];
  failed: Array<{ transactionId: string; reason: string }>;
  skipped: number;
}> {
  const actor = await actorFromSession();
  const cleaned = cleanApplyRows(input?.rows);
  const result = await applyTagDraft(actor, cleaned.rows);
  for (const row of cleaned.overflow) {
    result.failed.push({ transactionId: row.transactionId, reason: `Only ${TAG_APPLY_CHUNK} rows can be saved at a time.` });
  }
  if (result.applied.length > 0) {
    revalidatePath("/transactions");
    revalidatePath("/");
  }
  return result;
}

export async function undoSuggestedTags(input: { rows: AppliedTag[] }): Promise<{
  restored: number;
  failed: number;
}> {
  const actor = await actorFromSession();
  const rows = Array.isArray(input?.rows) ? input.rows.slice(0, TAG_APPLY_CHUNK) : [];
  const cleaned: AppliedTag[] = [];
  let failed = Math.max(0, (Array.isArray(input?.rows) ? input.rows.length : 0) - rows.length);
  for (const row of rows) {
    if (!row || typeof row.transactionId !== "string" || typeof row.categoryId !== "string") continue;
    if (typeof row.previousIsTransfer !== "boolean") {
      failed++;
      continue;
    }
    cleaned.push({
      transactionId: row.transactionId,
      previousCategoryId: typeof row.previousCategoryId === "string" ? row.previousCategoryId : null,
      categoryId: row.categoryId,
      previousIsTransfer: row.previousIsTransfer,
    });
  }
  const result = await undoTagDraft(actor, cleaned);
  if (result.restored.length > 0) {
    revalidatePath("/transactions");
    revalidatePath("/");
  }
  return { restored: result.restored.length, failed: result.failed.length + failed };
}

/** Sets the payee's default category only. Other transactions stay as they are. */
export async function rememberPayeeDefault(input: {
  counterpartyId: string;
  categoryId: string;
  confirmFromCategoryId?: string | null;
}) {
  const actor = await actorFromSession();
  const confirm = input?.confirmFromCategoryId;
  return rememberPayeeDefaultForActor(actor, {
    counterpartyId: typeof input?.counterpartyId === "string" ? input.counterpartyId : "",
    categoryId: typeof input?.categoryId === "string" ? input.categoryId : "",
    confirmFromCategoryId: typeof confirm === "string" ? confirm : null,
  });
}
