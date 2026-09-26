"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { requireCurrentUserAction } from "@/lib/auth/require-current-user";
import { checkAssistantRateLimit } from "@/lib/rate-limit";
import { isAiAllowed } from "@/lib/ai/access";
import { describeFailure, type AiLimits } from "@/lib/ai/failure";
import { getChatgptConnectionStatus } from "@/lib/ai/chatgpt/token-store";
import { runAgentTurn, runRulesTurn, type TurnContext } from "@/lib/assistant/agent";
import { loadCategories, loadOpenLinesForPerson, loadPersonNames, loadTxnCards } from "@/lib/assistant/data";
import { proposeNetSettle, proposeNote, proposeSplit } from "@/lib/assistant/proposals";
import { loadCounterpartyPersonHints } from "@/lib/people/counterparty-person-hints";
import { resolveDefaultPersonFilter } from "@/lib/people/match-counterparty";
import { counterpartyLabel } from "@/lib/format";
import type { CategoryLite, HistoryTurn, OpDraft, TurnMessage, TxnCardData } from "@/lib/assistant/types";

export type AiState = "ready" | "off" | "not_migrated" | "not_connected" | "reconnect";

export interface AssistantBootstrap {
  aiState: AiState;
  accountName: string;
  categories: CategoryLite[];
}

export type TurnResult =
  | {
      ok: true;
      reader: "ai" | "rules";
      messages: TurnMessage[];
      txns: TxnCardData[];
      focusTxnId: string | null;
      limits: AiLimits | null;
    }
  | { ok: false; error: string };

/** "Today" for the user, not the server — Vercel runs in UTC, the user is in India. */
const todayInIndia = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

async function aiStateFor(userId: string): Promise<AiState> {
  if (!isAiAllowed(userId)) return "off";
  const status = await getChatgptConnectionStatus(userId);
  if (status === "not_migrated") return "not_migrated";
  return status === "active" ? "ready" : status === "none" ? "not_connected" : "reconnect";
}

export async function getAssistantBootstrap(): Promise<AssistantBootstrap> {
  const user = await requireCurrentUserAction();
  const [account, aiState, categories] = await Promise.all([
    getOrCreateAccountForBank(user.id, "bob"),
    aiStateFor(user.id),
    loadCategories(user.id),
  ]);
  return { aiState, accountName: account.name, categories };
}

function cleanHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (h): h is HistoryTurn =>
        !!h && typeof h === "object" && (h.role === "user" || h.role === "assistant") && typeof h.text === "string",
    )
    .slice(-20)
    .map((h) => ({ role: h.role, text: h.text.slice(0, 600) }));
}

export async function assistantTurn(input: {
  message: string;
  history: HistoryTurn[];
  focusTxnId: string | null;
  resumedAfterPick?: boolean;
}): Promise<TurnResult> {
  const user = await requireCurrentUserAction();

  const message = String(input?.message ?? "").trim().slice(0, 1000);
  if (!message) return { ok: false, error: "Type something to ask." };
  if (!(await checkAssistantRateLimit(user.id))) {
    return { ok: false, error: "Too many requests in a short time. Try again in a few minutes." };
  }

  const account = await getOrCreateAccountForBank(user.id, "bob");
  // The focus id comes from the browser: keep it only if it's in this account.
  const focusTxnId =
    typeof input.focusTxnId === "string" && input.focusTxnId
      ? ((await loadTxnCards(account.id, user.id, [input.focusTxnId]))[0]?.id ?? null)
      : null;
  const [categories, knownPeople] = await Promise.all([loadCategories(user.id), loadPersonNames(user.id)]);

  const ctx: TurnContext = {
    userId: user.id,
    accountId: account.id,
    today: todayInIndia(),
    message,
    history: cleanHistory(input.history),
    focusTxnId,
    resumedAfterPick: input.resumedAfterPick === true,
    categories,
    knownPeople,
  };

  const aiState = await aiStateFor(user.id);
  let reader: "ai" | "rules" = "ai";
  let out;
  if (aiState === "ready") {
    out = await runAgentTurn(ctx);
    if (out.failure) {
      const notice = describeFailure(out.failure);
      if (out.messages.length > 0) {
        out.messages[0] = { ...out.messages[0], notice } as TurnMessage;
      } else {
        reader = "rules";
        out = { ...(await runRulesTurn(ctx, notice)), limits: out.limits };
      }
    }
  } else {
    reader = "rules";
    // The panel's banner already says AI is off or disconnected; repeating it
    // on every reply is noise. Per-reply notices are for failures mid-session.
    out = await runRulesTurn(ctx, "");
  }

  return {
    ok: true,
    reader,
    messages: out.messages,
    txns: await loadTxnCards(account.id, user.id, out.txnIds),
    focusTxnId: out.focusTxnId,
    limits: out.limits,
  };
}

/** Fresh card data — after an Apply/Undo, or when the panel reopens. */
export async function loadAssistantTxns(input: { ids: string[] }): Promise<TxnCardData[]> {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const ids = Array.isArray(input?.ids) ? input.ids.filter((id): id is string => typeof id === "string") : [];
  return loadTxnCards(account.id, user.id, ids);
}

/**
 * A blank or prefilled card from a transaction card's own buttons (no AI).
 * Same drafts and guards as the agent's propose_* tools.
 */
export async function prepareAssistantOp(input: {
  kind: "split" | "note" | "net";
  txnId: string;
}): Promise<{ ok: true; draft: OpDraft } | { ok: false; reason: string }> {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const [card] = await loadTxnCards(account.id, user.id, [String(input?.txnId ?? "")]);
  if (!card) return { ok: false, reason: "That transaction isn't available." };

  if (input.kind === "note") {
    const p = proposeNote(card, card.note ?? "");
    return p.ok ? { ok: true, draft: p.draft } : p;
  }
  if (input.kind === "split") {
    const p = proposeSplit(card, { mode: "equal", participants: [] }, []);
    return p.ok ? { ok: true, draft: p.draft } : p;
  }

  // Net settle: guess who sent it the same way the table's dialog does.
  const [row] = await db
    .select({
      counterpartyId: schema.transactions.counterpartyId,
      rawDescription: schema.transactions.rawDescription,
      displayName: schema.counterparties.displayName,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.counterparties,
      and(eq(schema.transactions.counterpartyId, schema.counterparties.id), eq(schema.counterparties.userId, user.id)),
    )
    .where(and(eq(schema.transactions.id, card.id), eq(schema.transactions.accountId, account.id)))
    .limit(1);
  const [hints, knownPeople] = await Promise.all([loadCounterpartyPersonHints(account.id), loadPersonNames(user.id)]);
  const person = row
    ? resolveDefaultPersonFilter({
        counterpartyId: row.counterpartyId,
        counterpartyDisplayName: row.displayName,
        rawDescription: row.rawDescription,
        knownPersonNames: knownPeople,
        counterpartyPersonHints: hints,
      })
    : "";
  if (!person) {
    return { ok: false, reason: "I can't tell who sent this. Ask me, e.g. \"Nitin sent me this — net settle it\"." };
  }
  const p = proposeNetSettle(card, person, await loadOpenLinesForPerson(account.id, user.id, person));
  return p.ok ? { ok: true, draft: p.draft } : p;
}

/**
 * Preview for "apply this category to every payment from this payee": how
 * many uncategorized rows it would change. Read-only — the card's Apply calls
 * the existing applyCategoryToCounterparty action.
 */
export async function prepareApplyToAll(input: {
  txnId: string;
}): Promise<{ ok: true; draft: OpDraft } | { ok: false; reason: string }> {
  const user = await requireCurrentUserAction();
  const account = await getOrCreateAccountForBank(user.id, "bob");
  const t = schema.transactions;
  const [row] = await db
    .select({
      counterpartyId: t.counterpartyId,
      categoryId: t.categoryId,
      rawDescription: t.rawDescription,
      displayName: schema.counterparties.displayName,
    })
    .from(t)
    .leftJoin(
      schema.counterparties,
      and(eq(t.counterpartyId, schema.counterparties.id), eq(schema.counterparties.userId, user.id)),
    )
    .where(and(eq(t.id, String(input?.txnId ?? "")), eq(t.accountId, account.id)))
    .limit(1);
  if (!row) return { ok: false, reason: "That transaction isn't available." };
  if (!row.categoryId) return { ok: false, reason: "Set a category on this payment first." };
  if (!row.counterpartyId) return { ok: false, reason: "This payment has no recognised payee to match others by." };

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(t)
    .where(and(eq(t.accountId, account.id), eq(t.counterpartyId, row.counterpartyId), isNull(t.categoryId)));
  if (count === 0) return { ok: false, reason: "No other uncategorized payments from this payee." };

  return {
    ok: true,
    draft: {
      op: "cat_all",
      txnId: String(input.txnId),
      categoryId: row.categoryId,
      payee: row.displayName ?? counterpartyLabel(row.rawDescription),
      count,
    },
  };
}
