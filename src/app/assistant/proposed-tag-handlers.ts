import "server-only";
import { Effect, Schema } from "effect";
import type { ActionSpec } from "@/lib/action/core";
import { sanitizedInput } from "@/lib/action/sanitized-input";
import { CurrentUser, type Db } from "@/lib/action/services";
import { Invalid, NotFound, Unavailable } from "@/lib/action/errors";
import { inArray } from "drizzle-orm";
import { schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { loadDraft, resolveDraft, type ProposedDraftSummary } from "@/lib/mcp/draft-store";
import { reviewProposedRows } from "@/lib/mcp/draft-review";
import { loadCategories, loadTxnCards } from "@/lib/assistant/data";
import { loadTagFacts } from "@/lib/assistant/tag-store";
import { chunkApplyRows } from "@/lib/assistant/tag-apply";
import type { TagDraftRow } from "@/lib/assistant/tag-batch";
import type { TxnCardData } from "@/lib/assistant/types";

export type { ProposedDraftSummary };

const openProposedTagDraftInput = sanitizedInput({ draftId: Schema.optional(Schema.Unknown) });
interface OpenDraftData {
  draftId: string;
  label: string;
  sourceLabel: string;
  title: string | null;
  total: number;
  changed: number;
  rows: TagDraftRow[];
  txns: TxnCardData[];
}
export const openProposedTagDraftSpec: ActionSpec<
  typeof openProposedTagDraftInput.Type,
  typeof openProposedTagDraftInput.Encoded,
  OpenDraftData,
  CurrentUser | Db
> = {
  input: openProposedTagDraftInput,
  handler: Effect.fn("openProposedTagDraft")(function* (input) {
    const user = yield* CurrentUser;
    if (typeof input?.draftId !== "string" || !input.draftId)
      return yield* new Invalid({ message: "Choose a proposed draft first." });
    const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
    const actor = {
      userId: user.id,
      accountId: account.id,
    };
    const draftId = input.draftId;
    const draft = yield* Effect.promise(() => loadDraft(actor, draftId));
    if (!draft)
      return yield* new NotFound({ message: "That pending draft isn't available." });
    const ids = draft.rows.map((r) => r.transactionId);
    const [facts, categories] = yield* Effect.promise(() => Promise.all([
      ids.length
        ? loadTagFacts(account.id, user.id, inArray(schema.transactions.id, ids))
        : Promise.resolve([]),
      loadCategories(user.id),
    ]));
    const review = reviewProposedRows(draft.rows, facts, categories, draft.sourceLabel, draft.malformed);
    const txns: TxnCardData[] = [];
    for (const chunk of chunkApplyRows(review.rows.map((r) => r.txnId))) {
      txns.push(...(yield* Effect.promise(() => loadTxnCards(account.id, user.id, chunk))));
    }
    return {
      draftId: draft.id,
      label: draft.title ? `${draft.title} · ${draft.sourceLabel}` : draft.sourceLabel,
      sourceLabel: draft.sourceLabel,
      title: draft.title,
      ...review,
      txns,
    };
  }),
};

const ResolveInput = Schema.Struct({
  draftId: Schema.NonEmptyString,
  status: Schema.Literals(["applied", "dismissed"]),
});
// Keep the original validation text rather than a schema-generated message.
export const resolveProposedTagDraftSpec: ActionSpec<unknown, unknown, void, CurrentUser | Db> = {
  input: Schema.Unknown,
  handler: Effect.fn("resolveProposedTagDraft")(function* (input) {
    const user = yield* CurrentUser;
    if (!Schema.is(ResolveInput)(input)) return yield* new Invalid({ message: "Choose a pending draft and an applied or dismissed status." });
    const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
    const result = yield* Effect.promise(() => resolveDraft({ userId: user.id, accountId: account.id }, input.draftId, input.status));
    if (!result.ok) return yield* result.error === "That pending draft isn't available."
      ? new NotFound({ message: result.error }) : new Unavailable({ message: result.error });
    return;
  }),
};
