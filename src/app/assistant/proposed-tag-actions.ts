"use server";

import { defineAction } from "@/lib/action/define-action";
import { openProposedTagDraftSpec, resolveProposedTagDraftSpec } from "./proposed-tag-handlers";
export type { ProposedDraftSummary } from "@/lib/mcp/draft-store";

export const openProposedTagDraft = defineAction("openProposedTagDraft", openProposedTagDraftSpec);
export const resolveProposedTagDraft = defineAction("resolveProposedTagDraft", resolveProposedTagDraftSpec);
