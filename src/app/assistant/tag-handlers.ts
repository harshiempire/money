import { refreshPaths } from "@/lib/ledger/capabilities";
import "server-only";
import { Effect, Schema } from "effect";
import type { ActionSpec } from "@/lib/action/core";
import { sanitizedInput } from "@/lib/action/sanitized-input";
import { CurrentUser, type Db } from "@/lib/action/services";
import { Invalid, NotFound, Conflict, Unavailable } from "@/lib/action/errors";
import { fromLedger } from "@/lib/action/ledger";

import { getOrCreateAccountForBank } from "@/db/money-account";
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
} from "@/lib/assistant/actor-ops";
import { loadTxnCards } from "@/lib/assistant/data";
import { TAG_APPLY_CHUNK, type AppliedTag, type TagApplyRequest } from "@/lib/assistant/tag-apply";
import { monthTitle, standingNotesForModel, type ContextNote, type ModelGuess, type TagDraftRow } from "@/lib/assistant/tag-batch";
import { suggestTagNames } from "@/lib/assistant/tag-suggest";
import type { CategoryLite, TxnCardData } from "@/lib/assistant/types";

const actorFromSession = Effect.fn("actorFromSession")(function* () {
  const user = yield* CurrentUser;
  const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
  return { userId: user.id, accountId: account.id };
});

const listContextNotesActionInput = Schema.Void;
export const listContextNotesActionSpec: ActionSpec<
  typeof listContextNotesActionInput.Type,
  typeof listContextNotesActionInput.Encoded,
  ContextNote[],
  CurrentUser | Db
> = {
  input: listContextNotesActionInput,
  handler: Effect.fn("listContextNotesAction")(function* () {
    const actor = yield* actorFromSession();
    return yield* Effect.promise(() => readStandingNotes(actor));
  }),
};

const saveContextNoteInput = sanitizedInput({ id: Schema.optional(Schema.Unknown), body: Schema.optional(Schema.Unknown) });
export const saveContextNoteSpec: ActionSpec<
  typeof saveContextNoteInput.Type,
  typeof saveContextNoteInput.Encoded,
  { note: ContextNote; warning?: string },
  CurrentUser | Db
> = {
  input: saveContextNoteInput,
  handler: Effect.fn("saveContextNote")(function* (input) {
    const actor = yield* actorFromSession();
    const body = typeof input?.body === "string" ? input.body : "";
    const id = typeof input?.id === "string" ? input.id : undefined;
    const saved = yield* Effect.promise(() => saveStandingNote(actor, { body, ...(id !== undefined ? { id } : {}) }));
    if (!saved.ok) return yield* noteFailure(saved.error);
    return { note: saved.note, warning: saved.warning };
  }),
};

const deleteContextNoteInput = sanitizedInput({ id: Schema.optional(Schema.Unknown) });
export const deleteContextNoteSpec: ActionSpec<
  typeof deleteContextNoteInput.Type,
  typeof deleteContextNoteInput.Encoded,
  void,
  CurrentUser | Db
> = {
  input: deleteContextNoteInput,
  handler: Effect.fn("deleteContextNote")(function* (input) {
    const actor = yield* actorFromSession();
    const id = typeof input?.id === "string" ? input.id : "";
    const removed = yield* Effect.promise(() => deleteStandingNote(actor, id));
    if (!removed.ok) return yield* noteFailure(removed.error);
    return;
  }),
};

/** The pending-card Apply for a note the model proposed. */
const addContextNoteInput = sanitizedInput({ body: Schema.optional(Schema.Unknown) });
export const addContextNoteSpec: ActionSpec<
  typeof addContextNoteInput.Type,
  typeof addContextNoteInput.Encoded,
  { id: string },
  CurrentUser | Db
> = {
  input: addContextNoteInput,
  handler: Effect.fn("addContextNote")(function* (input) {
    const actor = yield* actorFromSession();
    const saved = yield* Effect.promise(() => saveStandingNote(actor, { body: typeof input.body === "string" ? input.body : "" }));
    if (!saved.ok) return yield* new Invalid({ message: saved.error });
    return { id: saved.note.id };
  }),
};

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
  label: string;
  total: number;
  nextOffset: number | null;
  rows: TagDraftRow[];
  txns: TxnCardData[];
  suggester: "model" | "history" | "stub";
}

const suggestTagChunkInput = sanitizedInput({ year: Schema.optional(Schema.Unknown), month: Schema.optional(Schema.Unknown), offset: Schema.optional(Schema.Unknown) });
export const suggestTagChunkSpec: ActionSpec<
  typeof suggestTagChunkInput.Type,
  typeof suggestTagChunkInput.Encoded,
  TagChunkResult,
  CurrentUser | Db
> = {
  input: suggestTagChunkInput,
  handler: Effect.fn("suggestTagChunk")(function* (input) {
    const period = validPeriod(input?.year, input?.month);
    if (!period) return yield* new Invalid({ message: "Pick a month to tag." });
    const offset = typeof input?.offset === "number" && Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
    const actor = yield* actorFromSession();
    if (!(yield* Effect.promise(() => checkAssistantRateLimit(actor.userId)))) {
      return yield* new Unavailable({ message: "Too many requests in a short time. Try again in a few minutes." });
    }

    const snapshot = yield* Effect.promise(() => loadTagMonth(actor, period.year, period.month));
    const open = draftTagChunk(snapshot, { ...period, offset });
    let suggester: TagChunkResult["suggester"] = "history";
    let done = open;
    if (open.needsModel.length > 0) {
      let guesses: ModelGuess[] = [];
      if (stubEnabled()) {
        suggester = "stub";
        guesses = stubGuesses(open.needsModel, snapshot.categories);
      } else if (isAiAllowed(actor.userId)) {
        const access = yield* Effect.promise(() => getChatgptAccess(actor.userId));
        if (access.ok) {
          const suggested = yield* Effect.promise(() => suggestTagNames({
            accessToken: access.accessToken,
            accountId: access.accountId,
            model: assistantModel(),
            categories: snapshot.categories.map((c) => c.name),
            standingNotes: standingNotesForModel(snapshot.notes.map((note) => note.body)),
            rows: open.needsModel,
          }));
          suggester = suggested.failure ? "history" : "model";
          guesses = suggested.guesses;
        }
      }
      if (guesses.length > 0) done = draftTagChunk(snapshot, { ...period, offset, guesses });
    }

    const txns = yield* Effect.promise(() => loadTxnCards(actor.accountId, actor.userId, done.rows.map((row) => row.txnId)));
    return {
      label: monthTitle(period.year, period.month),
      total: done.total,
      nextOffset: done.nextOffset,
      rows: done.rows,
      txns,
      suggester,
    };
  }),
};

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

const applySuggestedTagsInput = sanitizedInput({ rows: Schema.optional(Schema.Unknown) });
export const applySuggestedTagsSpec: ActionSpec<
  typeof applySuggestedTagsInput.Type,
  typeof applySuggestedTagsInput.Encoded,
  { applied: AppliedTag[]; failed: Array<{ transactionId: string; reason: string }>; skipped: number },
  CurrentUser | Db
> = {
  input: applySuggestedTagsInput,
  revalidate: refreshPaths("transaction.fields"),
  revalidateWhen: (r) => r.applied.length > 0,
  handler: Effect.fn("applySuggestedTags")(function* (input) {
    const actor = yield* actorFromSession();
    const cleaned = cleanApplyRows(input?.rows);
    const result = yield* Effect.promise(() => applyTagDraft(actor, cleaned.rows));
    for (const row of cleaned.overflow) {
      result.failed.push({ transactionId: row.transactionId, reason: `Only ${TAG_APPLY_CHUNK} rows can be saved at a time.` });
    }

    return result;
  }),
};

const undoSuggestedTagsInput = sanitizedInput({ rows: Schema.optional(Schema.Unknown) });
export const undoSuggestedTagsSpec: ActionSpec<
  typeof undoSuggestedTagsInput.Type,
  typeof undoSuggestedTagsInput.Encoded,
  { restored: number; failed: number },
  CurrentUser | Db
> = {
  input: undoSuggestedTagsInput,
  revalidate: refreshPaths("transaction.fields"),
  revalidateWhen: (r) => r.restored > 0,
  handler: Effect.fn("undoSuggestedTags")(function* (input) {
    const actor = yield* actorFromSession();
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
    const result = yield* Effect.promise(() => undoTagDraft(actor, cleaned));

    return { restored: result.restored.length, failed: result.failed.length + failed };
  }),
};

/** Sets the payee's default category only. Other transactions stay as they are. */
const rememberPayeeDefaultInput = sanitizedInput({ counterpartyId: Schema.optional(Schema.Unknown), categoryId: Schema.optional(Schema.Unknown), confirmFromCategoryId: Schema.optional(Schema.Unknown) });
export const rememberPayeeDefaultSpec: ActionSpec<
  typeof rememberPayeeDefaultInput.Type,
  typeof rememberPayeeDefaultInput.Encoded,
  { confirm?: false } | { confirm: true; existingCategoryId: string; existingCategoryName: string; nextCategoryName: string },
  CurrentUser | Db
> = {
  input: rememberPayeeDefaultInput,
  handler: Effect.fn("rememberPayeeDefault")(function* (input) {
    const actor = yield* actorFromSession();
    const confirm = input?.confirmFromCategoryId;
    const result = yield* fromLedger(() => rememberPayeeDefaultForActor(actor, {
      counterpartyId: typeof input?.counterpartyId === "string" ? input.counterpartyId : "",
      categoryId: typeof input?.categoryId === "string" ? input.categoryId : "",
      ...(confirm !== undefined ? { confirmFromCategoryId: typeof confirm === "string" ? confirm : null } : {}),
    }));
    if (!result.ok) {
      if ("confirm" in result) return { confirm: result.confirm, existingCategoryId: result.existingCategoryId, existingCategoryName: result.existingCategoryName, nextCategoryName: result.nextCategoryName };
      return yield* result.error === "That payee or category isn't available." ? new NotFound({ message: result.error }) : new Invalid({ message: result.error });
    }
    return {};
  }),
};

function noteFailure(message: string) {
  if (message === "That note isn't available.") return new NotFound({ message });
  if (message === "Notes aren't available until migration 0012 is applied.") return new Unavailable({ message });
  if (message === "Notes are limited to 40.") return new Conflict({ message });
  return new Invalid({ message });
}
