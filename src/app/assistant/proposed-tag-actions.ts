"use server";

import { inArray } from "drizzle-orm";
import { Schema } from "effect";
import { schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import { listDrafts, loadDraft, resolveDraft, type ProposedDraftSummary } from "@/lib/mcp/draft-store";
import { reviewProposedRows } from "@/lib/mcp/draft-review";
import { loadCategories, loadTxnCards } from "@/lib/assistant/data";
import { loadTagFacts } from "@/lib/assistant/tag-store";
import { chunkApplyRows } from "@/lib/assistant/tag-apply";
import type { TagDraftRow } from "@/lib/assistant/tag-batch";
import type { TxnCardData } from "@/lib/assistant/types";

export type { ProposedDraftSummary };

export async function listProposedTagDrafts(): Promise<ProposedDraftSummary[]> {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  return listDrafts({
    userId: user.id,
    accountId: account.id,
  });
}

export async function openProposedTagDraft(input: { draftId: string }): Promise<
  | {
      ok: true;
      draftId: string;
      label: string;
      sourceLabel: string;
      title: string | null;
      total: number;
      changed: number;
      rows: TagDraftRow[];
      txns: TxnCardData[];
    }
  | {
      ok: false;
      error: string;
    }
> {
  const user = await requireCurrentUserAction();
  if (typeof input?.draftId !== "string" || !input.draftId)
    return {
      ok: false,
      error: "Choose a proposed draft first.",
    };
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const actor = {
    userId: user.id,
    accountId: account.id,
  };
  const draft = await loadDraft(actor, input.draftId);
  if (!draft)
    return {
      ok: false,
      error: "That pending draft isn't available.",
    };
  const ids = draft.rows.map((r) => r.transactionId);
  const [facts, categories] = await Promise.all([
    ids.length
      ? loadTagFacts(account.id, user.id, inArray(schema.transactions.id, ids))
      : Promise.resolve([]),
    loadCategories(user.id),
  ]);
  const review = reviewProposedRows(draft.rows, facts, categories, draft.sourceLabel, draft.malformed);
  const txns: TxnCardData[] = [];
  for (const chunk of chunkApplyRows(review.rows.map((r) => r.txnId))) {
    txns.push(...(await loadTxnCards(account.id, user.id, chunk)));
  }
  return {
    ok: true,
    draftId: draft.id,
    label: draft.title ? `${draft.title} · ${draft.sourceLabel}` : draft.sourceLabel,
    sourceLabel: draft.sourceLabel,
    title: draft.title,
    ...review,
    txns,
  };
}

const ResolveInput = Schema.Struct({
  draftId: Schema.NonEmptyString,
  status: Schema.Literals(["applied", "dismissed"]),
});
export async function resolveProposedTagDraft(input: {
  draftId: string;
  status: "applied" | "dismissed";
}): Promise<
  | { ok: true }
  | {
      ok: false;
      error: string;
    }
> {
  const user = await requireCurrentUserAction();
  if (!Schema.is(ResolveInput)(input))
    return {
      ok: false,
      error: "Choose a pending draft and an applied or dismissed status.",
    };
  const account = await getOrCreateAccountForBank(user.id, "bob");
  return resolveDraft(
    {
      userId: user.id,
      accountId: account.id,
    },
    input.draftId,
    input.status,
  );
}
