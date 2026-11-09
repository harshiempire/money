import "server-only";
import { Effect, Schema } from "effect";
import type { ActionSpec } from "@/lib/action/core";
import { sanitizedInput } from "@/lib/action/sanitized-input";
import { CurrentUser, type Db } from "@/lib/action/services";
import { Invalid, NotFound, Conflict, Unavailable } from "@/lib/action/errors";

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getOrCreateAccountForBank } from "@/db/money-account";
import { checkAssistantRateLimit } from "@/lib/rate-limit";
import { isAiAllowed } from "@/lib/ai/access";
import { describeFailure, type AiLimits } from "@/lib/ai/failure";
import { getChatgptConnectionStatus } from "@/lib/ai/chatgpt/token-store";
import { runAgentTurn, runRulesTurn, type TurnContext } from "@/lib/assistant/agent";
import { loadCategories, loadOpenLinesForPerson, loadPersonNames, loadTxnCards } from "@/lib/assistant/data";
import { proposeNetSettle, proposeNote, proposeSplit } from "@/lib/assistant/proposals";
import { listUntaggedMonthsForActor, notesForModel, readStandingNotes, type MoneyActor } from "@/lib/assistant/actor-ops";
import { monthTitle, parseTagRequest, type ContextNote, type UntaggedMonth } from "@/lib/assistant/tag-batch";
import { loadCounterpartyPersonHints } from "@/lib/people/counterparty-person-hints";
import { resolveDefaultPersonFilter } from "@/lib/people/match-counterparty";
import { counterpartyLabel } from "@/lib/format";
import type { CategoryLite, HistoryTurn, OpDraft, TurnMessage, TxnCardData } from "@/lib/assistant/types";
import { listDrafts, type ProposedDraftSummary } from "@/lib/mcp/draft-store";

export type AiState = "ready" | "off" | "not_migrated" | "not_connected" | "reconnect";

export interface AssistantBootstrap {
  aiState: AiState;
  accountName: string;
  categories: CategoryLite[];
  /** Newest first. The first entry is the Tag button's default month. */
  untaggedMonths: UntaggedMonth[];
  contextNotes: ContextNote[];
  proposedDrafts: ProposedDraftSummary[];
}

export interface TurnData {
  reader: "ai" | "rules";
  messages: TurnMessage[];
  txns: TxnCardData[];
  focusTxnId: string | null;
  limits: AiLimits | null;
}
export type TurnResult = import("@/lib/action/result").ActionResult<TurnData>;


/** "Today" for the user, not the server — Vercel runs in UTC, the user is in India. */
const todayInIndia = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

async function aiStateFor(userId: string): Promise<AiState> {
  if (!isAiAllowed(userId)) return "off";
  const status = await getChatgptConnectionStatus(userId);
  if (status === "not_migrated") return "not_migrated";
  return status === "active" ? "ready" : status === "none" ? "not_connected" : "reconnect";
}

function actorFor(userId: string, accountId: string): MoneyActor {
  return { userId, accountId };
}

const getAssistantBootstrapInput = Schema.Void;
export const getAssistantBootstrapSpec: ActionSpec<
  typeof getAssistantBootstrapInput.Type,
  typeof getAssistantBootstrapInput.Encoded,
  AssistantBootstrap,
  CurrentUser | Db
> = {
  input: getAssistantBootstrapInput,
  handler: Effect.fn("getAssistantBootstrap")(function* () {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
    const actor = actorFor(user.id, account.id);
    const [aiState, categories, untaggedMonths, contextNotes, proposedDrafts] = yield* Effect.promise(() => Promise.all([
      aiStateFor(user.id),
      loadCategories(user.id),
      listUntaggedMonthsForActor(actor),
      readStandingNotes(actor),
      listDrafts(actor),
    ]));
    return { aiState, accountName: account.name, categories, untaggedMonths, contextNotes, proposedDrafts };
  }),
};

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

const assistantTurnInput = sanitizedInput({ message: Schema.optional(Schema.Unknown), history: Schema.optional(Schema.Unknown), focusTxnId: Schema.optional(Schema.Unknown), resumedAfterPick: Schema.optional(Schema.Unknown), focusPicked: Schema.optional(Schema.Unknown) });
export const assistantTurnSpec: ActionSpec<
  typeof assistantTurnInput.Type,
  typeof assistantTurnInput.Encoded,
  TurnData,
  CurrentUser | Db
> = {
  input: assistantTurnInput,
  handler: Effect.fn("assistantTurn")(function* (input) {
    const user = yield* CurrentUser;

    const message = String(input?.message ?? "").trim().slice(0, 1000);
    if (!message) return yield* new Invalid({ message: "Type something to ask." });
    if (!(yield* Effect.promise(() => checkAssistantRateLimit(user.id)))) {
      return yield* new Unavailable({ message: "Too many requests in a short time. Try again in a few minutes." });
    }

    const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
    // The focus id comes from the browser: keep it only if it's in this account.
    const requestedFocus = input.focusTxnId;
    const focusTxnId =
      typeof requestedFocus === "string" && requestedFocus
        ? ((yield* Effect.promise(() => loadTxnCards(account.id, user.id, [requestedFocus])))[0]?.id ?? null)
        : null;
    const actor = actorFor(user.id, account.id);
    const [categories, knownPeople, standingNotes, untaggedMonths] = yield* Effect.promise(() => Promise.all([
      loadCategories(user.id),
      loadPersonNames(user.id),
      notesForModel(actor),
      listUntaggedMonthsForActor(actor),
    ]));
    const today = todayInIndia();
    const tag = parseTagRequest(message, untaggedMonths, today);
    if (tag) {
      return {
        reader: "rules",
        messages: [
          {
            kind: "ai",
            text: `Reviewing untagged payments in ${monthTitle(tag.year, tag.month)}. Nothing is saved until you apply.`,
          },
          { kind: "tag_run", year: tag.year, month: tag.month },
        ],
        txns: [],
        focusTxnId,
        limits: null,
      };
    }

    const ctx: TurnContext = {
      userId: user.id,
      accountId: account.id,
      today,
      message,
      history: cleanHistory(input.history),
      focusTxnId,
      resumedAfterPick: input.resumedAfterPick === true,
      focusPicked: input.focusPicked === true && focusTxnId !== null,
      categories,
      knownPeople,
      standingNotes,
    };

    const aiState = yield* Effect.promise(() => aiStateFor(user.id));
    let reader: "ai" | "rules" = "ai";
    let out;
    if (aiState === "ready") {
      out = yield* Effect.promise(() => runAgentTurn(ctx));
      if (out.failure) {
        const notice = describeFailure(out.failure);
        if (out.messages.length > 0) {
          out.messages[0] = { ...out.messages[0], notice } as TurnMessage;
        } else {
          reader = "rules";
          out = { ...(yield* Effect.promise(() => runRulesTurn(ctx, notice))), limits: out.limits };
        }
      }
    } else {
      reader = "rules";
      // The panel's banner already says AI is off or disconnected; repeating it
      // on every reply is noise. Per-reply notices are for failures mid-session.
      out = yield* Effect.promise(() => runRulesTurn(ctx, ""));
    }

    return {
      reader,
      messages: out.messages,
      txns: yield* Effect.promise(() => loadTxnCards(account.id, user.id, out.txnIds)),
      focusTxnId: out.focusTxnId,
      limits: out.limits,
    };
  }),
};

/** Fresh card data — after an Apply/Undo, or when the panel reopens. */
const loadAssistantTxnsInput = sanitizedInput({ ids: Schema.optional(Schema.Unknown) });
export const loadAssistantTxnsSpec: ActionSpec<
  typeof loadAssistantTxnsInput.Type,
  typeof loadAssistantTxnsInput.Encoded,
  TxnCardData[],
  CurrentUser | Db
> = {
  input: loadAssistantTxnsInput,
  handler: Effect.fn("loadAssistantTxns")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
    const ids = Array.isArray(input?.ids) ? input.ids.filter((id): id is string => typeof id === "string") : [];
    return yield* Effect.promise(() => loadTxnCards(account.id, user.id, ids));
  }),
};

/**
 * A blank or prefilled card from a transaction card's own buttons (no AI).
 * Same drafts and guards as the agent's propose_* tools.
 */
const prepareAssistantOpInput = sanitizedInput({ kind: Schema.optional(Schema.Unknown), txnId: Schema.optional(Schema.Unknown) });
export const prepareAssistantOpSpec: ActionSpec<
  typeof prepareAssistantOpInput.Type,
  typeof prepareAssistantOpInput.Encoded,
  { draft: OpDraft },
  CurrentUser | Db
> = {
  input: prepareAssistantOpInput,
  handler: Effect.fn("prepareAssistantOp")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
    const [card] = yield* Effect.promise(() => loadTxnCards(account.id, user.id, [String(input?.txnId ?? "")]));
    if (!card) return yield* new NotFound({ message: "That transaction isn't available." });

    if (input.kind === "note") {
      const p = proposeNote(card, card.note ?? "");
      if (!p.ok) return yield* proposalFailure(p.reason);
      return { draft: p.draft };
    }
    if (input.kind === "split") {
      const p = proposeSplit(card, { mode: "equal", participants: [] }, []);
      if (!p.ok) return yield* proposalFailure(p.reason);
      return { draft: p.draft };
    }

    // Net settle: guess who sent it the same way the table's dialog does.
    const [row] = yield* Effect.promise(() => db
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
      .limit(1));
    const [hints, knownPeople] = yield* Effect.promise(() => Promise.all([loadCounterpartyPersonHints(account.id), loadPersonNames(user.id)]));
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
      return yield* new Invalid({ message: "I can't tell who sent this. Ask me, e.g. \"Kiran sent me this — net settle it\"." });
    }
    const p = proposeNetSettle(card, person, yield* Effect.promise(() => loadOpenLinesForPerson(account.id, user.id, person)));
    if (!p.ok) return yield* proposalFailure(p.reason);
      return { draft: p.draft };
  }),
};

/**
 * Preview for "apply this category to every payment from this payee": how
 * many uncategorized rows it would change. Read-only — the card's Apply calls
 * the existing applyCategoryToCounterparty action.
 */
const prepareApplyToAllInput = sanitizedInput({ txnId: Schema.optional(Schema.Unknown) });
export const prepareApplyToAllSpec: ActionSpec<
  typeof prepareApplyToAllInput.Type,
  typeof prepareApplyToAllInput.Encoded,
  { draft: OpDraft },
  CurrentUser | Db
> = {
  input: prepareApplyToAllInput,
  handler: Effect.fn("prepareApplyToAll")(function* (input) {
    const user = yield* CurrentUser;
    const account = yield* Effect.promise(() => getOrCreateAccountForBank(user.id, "bob"));
    const t = schema.transactions;
    const [row] = yield* Effect.promise(() => db
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
      .limit(1));
    if (!row) return yield* new NotFound({ message: "That transaction isn't available." });
    if (!row.categoryId) return yield* new Invalid({ message: "Set a category on this payment first." });
    if (!row.counterpartyId) return yield* new Invalid({ message: "This payment has no recognised payee to match others by." });

    const counterpartyId = row.counterpartyId;
    const [{ count }] = yield* Effect.promise(() => db
      .select({ count: sql<number>`count(*)::int` })
      .from(t)
      .where(and(eq(t.accountId, account.id), eq(t.counterpartyId, counterpartyId), isNull(t.categoryId))));
    if (count === 0) return yield* new Invalid({ message: "No other uncategorized payments from this payee." });

    return {
      draft: {
        op: "cat_all",
        txnId: String(input.txnId),
        categoryId: row.categoryId,
        payee: row.displayName ?? counterpartyLabel(row.rawDescription),
        count,
      },
    };
  }),
};

function proposalFailure(message: string) {
  if (
    message === "This payment already has a split. Edit it from the Split button in the table so existing settlements aren't lost." ||
    message === "That payment is already net settled. Change it from Net ✓ in the table." ||
    message.startsWith("Nothing is open between you and ")
  ) return new Conflict({ message });
  return new Invalid({ message });
}
