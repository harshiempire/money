import type { CategoryLite } from "@/lib/assistant/types";
import { refForIndex, type TagDraftRow, type TagFact } from "@/lib/assistant/tag-batch";
import type { StoredTagRow } from "./proposal";

export function reviewProposedRows(
  stored: StoredTagRow[],
  facts: TagFact[],
  categories: CategoryLite[],
  sourceLabel: string,
  malformed = 0,
) {
  const byId = new Map(facts.map((t) => [t.id, t]));
  const categoryIds = new Set(categories.map((c) => c.id));
  const rows: TagDraftRow[] = [];
  let changed = malformed;
  for (const proposal of stored) {
    const txn = byId.get(proposal.transactionId);
    if (
      !txn ||
      txn.categoryId !== proposal.expectedCurrentCategoryId ||
      !categoryIds.has(proposal.categoryId)
    ) {
      changed++;
      continue;
    }
    rows.push({
      kind: "suggest",
      txnId: txn.id,
      ref: refForIndex(rows.length),
      suggestedCategoryId: proposal.categoryId,
      confidence: proposal.confidence,
      reason: `${sourceLabel.slice(0, 40)}: ${proposal.reason ?? "Suggested category"}`.slice(0, 125),
      source: "model",
      choices: [],
      transfer: txn.isTransfer,
      counterpartyId: txn.counterpartyId,
      defaultCategoryId: txn.defaultCategoryId,
    });
  }
  return {
    rows,
    changed,
    total: rows.length,
  };
}
