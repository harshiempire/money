/**
 * Apply and Undo for pending cards. Every write goes through the existing
 * authenticated server actions (which re-check ownership and re-validate the
 * money) with the values the user edited — never the model's raw output.
 */
import {
  applyCategoryToCounterparty,
  setTransactionCategory,
  setTransactionNote,
} from "@/app/transactions/actions";
import { createSplit, deleteSplit } from "@/app/transactions/split-actions";
import { deleteNetEvent, saveNetEvent } from "@/app/transactions/net-event-actions";
import { loadAssistantTxns } from "@/app/assistant/actions";
import { buildNetLegs } from "@/lib/net-events/build-legs";
import { formatPaise } from "@/lib/format";
import { netBalance, splitBalance, typedPaise } from "@/lib/assistant/card-math";
import type { CategoryLite, OpDraft, TxnCardData, UndoInfo } from "@/lib/assistant/types";

export function draftReady(draft: OpDraft): boolean {
  switch (draft.op) {
    case "split":
      return splitBalance(draft.totalPaise, draft.yourShare, draft.parts).ok;
    case "note":
      return draft.note.trim().length > 0;
    case "cat":
      return draft.categoryId !== (draft.currentCategoryId ?? "");
    case "cat_all":
      return draft.count > 0;
    case "net":
      return netBalance(draft.inflowPaise, draft.recv, draft.pay).ok;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function applyDraft(
  draft: OpDraft,
  txn: TxnCardData | undefined,
  categories: CategoryLite[],
): Promise<{ undo: UndoInfo; message: string; offerApplyToAll?: boolean }> {
  switch (draft.op) {
    case "note": {
      const note = draft.note.trim();
      await setTransactionNote({ transactionId: draft.txnId, note, expectedCurrentNote: draft.currentNote });
      return {
        undo: { kind: "note", prevNote: draft.currentNote, appliedNote: note },
        message: draft.currentNote ? "Note replaced." : "Note added.",
      };
    }
    case "cat": {
      await setTransactionCategory({
        transactionId: draft.txnId,
        categoryId: draft.categoryId,
        expectedCurrentCategoryId: draft.currentCategoryId,
      });
      const name = categories.find((c) => c.id === draft.categoryId)?.name;
      return {
        undo: { kind: "cat", prevCategoryId: draft.currentCategoryId, appliedCategoryId: draft.categoryId },
        message: name ? `${txn?.label ?? "It"} is now ${name}.` : `${txn?.label ?? "It"} is now uncategorized.`,
        offerApplyToAll: Boolean(name),
      };
    }
    case "cat_all": {
      // applyCategoryToCounterparty copies this payment's *current* category,
      // so make sure it's still the one the card shows.
      const [fresh] = await loadAssistantTxns({ ids: [draft.txnId] });
      if (fresh?.categoryId !== draft.categoryId) {
        throw new Error("This payment's category changed since the card was made. Ask again for a fresh card.");
      }
      const { updated, ids } = await applyCategoryToCounterparty({ transactionId: draft.txnId });
      const name = categories.find((c) => c.id === draft.categoryId)?.name ?? "that category";
      return {
        undo: { kind: "cat_all", ids, categoryId: draft.categoryId },
        message: `Set ${name} on ${plural(updated, "more payment")} from ${draft.payee}. New payments from them will default to ${name}.`,
      };
    }
    case "split": {
      const balance = splitBalance(draft.totalPaise, draft.yourShare, draft.parts);
      if (!balance.ok) throw new Error("The split doesn't balance yet.");
      const participants = draft.parts
        .filter((p) => p.name.trim() && p.amt.trim())
        .map((p) => ({ personName: p.name.trim(), expectedAmountPaise: typedPaise(p.amt) }))
        .filter((p) => p.expectedAmountPaise > 0);
      await createSplit({
        transactionId: draft.txnId,
        totalPaise: draft.totalPaise,
        yourSharePaise: balance.yourSharePaise,
        note: null,
        participants,
        expectNoExistingSplit: true,
      });
      const owes = participants.map((p) => `${p.personName} owes you ${formatPaise(p.expectedAmountPaise)}`).join(", ");
      return {
        undo: { kind: "split" },
        message: `Split saved. ${owes}. Your spend on this is now ${formatPaise(balance.yourSharePaise)}.`,
      };
    }
    case "net": {
      if (!netBalance(draft.inflowPaise, draft.recv, draft.pay).ok) throw new Error("The lines don't balance yet.");
      const lines = (ls: typeof draft.recv) => ls.map((l) => ({ id: l.id, paise: typedPaise(l.val) }));
      const legs = buildNetLegs({
        receivables: lines(draft.recv),
        payables: lines(draft.pay),
        inflowTransactionId: draft.txnId,
        inflowAmountPaise: draft.inflowPaise,
      });
      const { netEventId } = await saveNetEvent({
        eventDate: draft.eventDate,
        inflowTransactionId: draft.txnId,
        note: draft.note.trim() || undefined,
        legs,
      });
      const r = draft.recv.filter((l) => typedPaise(l.val) > 0).length;
      const p = draft.pay.filter((l) => typedPaise(l.val) > 0).length;
      return {
        undo: { kind: "net", netEventId },
        message: `Net event saved with ${draft.person} — ${plural(r, "receivable")} and ${plural(p, "payable")} settled against ${formatPaise(draft.inflowPaise)}.`,
      };
    }
  }
}

/** `fresh` is the transaction re-read just before undoing. */
export async function undoDraft(draft: OpDraft, undo: UndoInfo, fresh: TxnCardData | undefined): Promise<string> {
  switch (undo.kind) {
    case "note":
      await setTransactionNote({
        transactionId: draft.txnId,
        note: undo.prevNote ?? "",
        expectedCurrentNote: undo.appliedNote,
      });
      return undo.prevNote ? "Put the previous note back." : "Note removed.";
    case "cat":
      await setTransactionCategory({
        transactionId: draft.txnId,
        categoryId: undo.prevCategoryId ?? "",
        expectedCurrentCategoryId: undo.appliedCategoryId || null,
      });
      return "Category put back.";
    case "cat_all": {
      let reverted = 0;
      let skipped = 0;
      for (const id of undo.ids) {
        try {
          // Only rows still carrying the category we set — anything re-categorized since is left alone.
          await setTransactionCategory({ transactionId: id, categoryId: "", expectedCurrentCategoryId: undo.categoryId });
          reverted++;
        } catch {
          skipped++;
        }
      }
      return `Put ${plural(reverted, "payment")} back to uncategorized.${
        skipped ? ` ${plural(skipped, "payment")} had changed since and were left alone.` : ""
      } The payee's default category stays as it is.`;
    }
    case "split": {
      if (!fresh?.split) return "The split was already removed.";
      if (draft.op === "split") {
        const b = splitBalance(draft.totalPaise, draft.yourShare, draft.parts);
        const people = draft.parts.filter((p) => p.name.trim() && typedPaise(p.amt) > 0).length;
        if (fresh.split.participants !== people || fresh.split.yourSharePaise !== b.yourSharePaise) {
          throw new Error("This split was edited in the table since. Change it there instead.");
        }
      }
      // The server refuses if any money was settled against it in the meantime.
      await deleteSplit({ transactionId: draft.txnId, expectNoSettlements: true });
      return "Split removed.";
    }
    case "net":
      await deleteNetEvent({ netEventId: undo.netEventId });
      return "Net event reversed.";
  }
}

/** Scroll the table row into view and flash it, or open the table on it. */
export function showInTable(txn: Pick<TxnCardData, "id" | "href">) {
  // The table and the mobile list both carry the id; use whichever is visible.
  const row = [...document.querySelectorAll<HTMLElement>(`[id="txn-${CSS.escape(txn.id)}"]`)].find(
    (el) => el.offsetParent !== null,
  );
  if (!row) {
    window.location.href = txn.href;
    return;
  }
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  flashRow(txn.id);
}

const FLASH = ["!bg-sky-100", "dark:!bg-sky-950/45", "transition-colors", "duration-500"];

export function flashRow(id: string) {
  for (const row of document.querySelectorAll(`[id="txn-${CSS.escape(id)}"]`)) {
    row.classList.add(...FLASH);
    window.setTimeout(() => row.classList.remove(...FLASH), 1800);
  }
}
