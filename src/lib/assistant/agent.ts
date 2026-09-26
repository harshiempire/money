import "server-only";
/**
 * The Ask Money agent: one user turn → a few model steps with tools → chat
 * messages for the panel.
 *
 * Contract (see AGENTS.md): read tools run immediately against the signed-in
 * user's account; write tools never write — they return a draft that the
 * panel renders as a pending card, and only the user's Apply calls the
 * existing server actions. The model refers to transactions only by refs the
 * server handed out (T1…, CURRENT), so it can't point at rows it wasn't
 * shown, and every amount/date it passes is re-read by the server.
 */
import { assistantModel } from "@/lib/ai/access";
import type { AiFailure, AiLimits } from "@/lib/ai/failure";
import { callAgentStep, type FunctionCall, type FunctionTool, type ResponseItem } from "@/lib/ai/chatgpt/responses";
import { getChatgptAccess } from "@/lib/ai/chatgpt/token-store";
import { dateWindows } from "@/lib/dates/partial-date";
import { parseAmountToPaise } from "@/lib/money/parse-amount";
import { findTransactionCandidates, yearsWithData } from "@/lib/transactions/search";
import { counterpartyLabel } from "@/lib/format";
import { groundIntent, namedByUser, type Direction, type GroundedCriteria } from "./find-intent";
import { rankCandidates } from "./rank";
import { rulesIntent } from "./rules-intent";
import { MONTH_ABBR, modelAmount, modelDate, modelSafePayee } from "./model-view";
import { proposeCategory, proposeNetSettle, proposeNote, proposeSplit, type Proposal } from "./proposals";
import { loadOpenLinesForPerson, loadTxnCards } from "./data";
import { resolvePerson } from "./card-math";
import type { CategoryLite, HistoryTurn, OpDraft, TurnMessage, TxnCardData } from "./types";

const MAX_STEPS = 5;
const MAX_SHOWN = 8;

const str = (description: string) => ({ type: "string", description });
const nullableStr = (description: string) => ({ type: ["string", "null"], description });

export const AGENT_TOOLS: FunctionTool[] = [
  {
    type: "function",
    name: "search_transactions",
    description:
      "Find the user's bank transactions. Copy the amount and date exactly as the user wrote them — never add a year they didn't say, never compute. Returns refs (T1, T2…) to use with the other tools.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["amount_text", "date_text", "text", "direction", "purpose"],
      properties: {
        amount_text: nullableStr('Amount exactly as written, e.g. "₹760", or null.'),
        date_text: nullableStr('Date exactly as written, e.g. "28 Aug", "August", "yesterday", or null.'),
        text: nullableStr("A merchant, person or note word to match, or null."),
        direction: { type: "string", enum: ["debit", "credit", "any"], description: "debit = paid out, credit = received." },
        purpose: {
          type: "string",
          enum: ["show", "act"],
          description: '"act" when the user wants to change the transaction (note, split, category, settle); otherwise "show".',
        },
      },
    },
  },
  {
    type: "function",
    name: "get_open_balances",
    description: "What a person still owes the user from splits, and what the user owes them.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["person_name"],
      properties: { person_name: str("The person's name as the user said it.") },
    },
  },
  {
    type: "function",
    name: "propose_note",
    description: "Show the user a pending card to set a transaction's note. Nothing is saved until they apply it.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["txn_ref", "note_text"],
      properties: {
        txn_ref: str("T1, T2… from a search, or CURRENT."),
        note_text: str("The note, in the user's words."),
      },
    },
  },
  {
    type: "function",
    name: "propose_split",
    description:
      "Show a pending card splitting a payment the user made. Participants are other people only, never the user. equal = everyone including the user pays the same; paid_for_them = the user covered it and the others owe all of it; custom = amounts the user stated.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["txn_ref", "mode", "participants"],
      properties: {
        txn_ref: str("T1, T2… from a search, or CURRENT."),
        mode: { type: "string", enum: ["equal", "paid_for_them", "custom"] },
        participants: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "amount_text"],
            properties: {
              name: str("Person's name."),
              amount_text: nullableStr("Their amount exactly as the user wrote it (custom only), else null."),
            },
          },
        },
      },
    },
  },
  {
    type: "function",
    name: "propose_category",
    description: "Show a pending card to set a transaction's category (one of the user's categories).",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["txn_ref", "category_name"],
      properties: { txn_ref: str("T1, T2… or CURRENT."), category_name: str("Category name.") },
    },
  },
  {
    type: "function",
    name: "propose_net_settle",
    description:
      "Show a pending card that settles an incoming payment from a person against everything open between them and the user (what they owe and what the user owes them).",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["txn_ref", "person_name"],
      properties: { txn_ref: str("The incoming payment: T1… or CURRENT."), person_name: str("Who sent it.") },
    },
  },
];

export interface TurnContext {
  userId: string;
  accountId: string;
  today: string;
  message: string;
  history: HistoryTurn[];
  focusTxnId: string | null;
  /** The user picked CURRENT from a list to continue this request. */
  resumedAfterPick: boolean;
  categories: CategoryLite[];
  knownPeople: string[];
}

export interface TurnOutput {
  messages: TurnMessage[];
  txnIds: string[];
  focusTxnId: string | null;
  limits: AiLimits | null;
  failure: AiFailure | null;
}

interface TurnState {
  refs: Map<string, string>;
  /** Refs from a search that matched several rows — the user must pick first. */
  unpickedRefs: Set<string>;
  trace: string[];
  artifacts: TurnMessage[];
  txnIds: Set<string>;
  focus: string | null;
  proposed: OpDraft["op"] | null;
}

function describeTxnForModel(card: TxnCardData, categories: CategoryLite[]): string {
  const category = categories.find((c) => c.id === card.categoryId)?.name ?? "none";
  const split = card.split
    ? `split with ${card.split.participants} (${card.split.settled}/${card.split.participants} settled)`
    : "none";
  return [
    modelDate(card.txnDate),
    `${card.drCr === "debit" ? "paid" : "received"} ${modelAmount(card.amountPaise)}`,
    `payee ${modelSafePayee({ counterpartyDisplayName: null, parsedPurpose: card.purpose, label: card.label })}`,
    `note: ${card.note ? `"${card.note.slice(0, 120)}"` : "none"}`,
    `category: ${category}`,
    `split: ${split}`,
    card.netEventId ? "already net settled" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function instructions(ctx: TurnContext, current: TxnCardData | null): string {
  return `You are Ask Money, the assistant inside a personal finance app for one person in India. Amounts are Indian rupees.
You can find transactions and PROPOSE changes: notes, splits, categories and net settlements. You never change anything yourself — propose_* tools show the user an editable card, and only their Apply button saves it.

Rules:
- Use search_transactions to find transactions. Copy amounts and dates exactly as the user wrote them. Never add a year they didn't say. Never compute amounts.
- Refer to transactions only by refs from tools (T1, T2…) or CURRENT. Never invent refs, amounts, dates or names.
- "it", "this", "that one" mean CURRENT when there is one.
- If a search finds several and the user wants to change one, don't choose — say the list is shown and ask them to pick.
- Splits: "half each" / "between us" → equal; "I paid for him/her" → paid_for_them; stated amounts → custom with amount_text copied. The user is never a participant.
- People: use names the user gave, now or earlier in this chat. If you can't tell who "him"/"her"/"them" is, ask.
- If something needed is missing or ambiguous, ask one short question instead of guessing.
- Keep replies to one or two short sentences. Only state amounts that came from a tool result.
- You can't delete transactions, move money, or change anything besides notes, splits, categories and net settlements.

The user's categories: ${ctx.categories.map((c) => c.name).join(", ") || "none yet"}.
People they've split with before: ${ctx.knownPeople.slice(0, 40).join(", ") || "none yet"}.
CURRENT: ${current ? describeTxnForModel(current, ctx.categories) : "none"}${
    ctx.resumedAfterPick && current
      ? "\nThe user just picked CURRENT from the list for the request below. Use CURRENT; don't search again."
      : ""
  }`;
}

function describeSearch(g: GroundedCriteria, windows: ReturnType<typeof dateWindows>): string {
  const parts: string[] = [];
  if (g.amountPaise !== null) parts.push(`amount: ${modelAmount(g.amountPaise)}`);
  if (g.date) {
    parts.push(
      windows.length === 1
        ? `${windows[0].from} → ${windows[0].to}`
        : `date: ${[g.date.day, g.date.month && MONTH_ABBR[g.date.month - 1]].filter(Boolean).join(" ")}, any year`,
    );
  }
  if (g.text) parts.push(`text: "${g.text}"`);
  if (g.direction !== "any") parts.push(g.direction);
  return `search_transactions(${parts.join(", ")})`;
}

async function runSearch(
  args: { amount_text: string | null; date_text: string | null; text: string | null; direction: Direction; purpose: "show" | "act" },
  ctx: TurnContext,
  state: TurnState,
  groundingText: string,
): Promise<object> {
  const g = groundIntent(
    {
      kind: "find_transactions",
      amountText: args.amount_text,
      dateText: args.date_text,
      textQuery: args.text,
      direction: args.direction,
      question: null,
    },
    groundingText,
    ctx.today,
  );
  if (g.amountPaise === null && g.date === null && g.text === null) {
    state.trace.push("search_transactions(—) → nothing to search by");
    return {
      error: g.unreadable.length
        ? `Couldn't read "${g.unreadable.join('", "')}" exactly. Ask the user to restate it.`
        : "Nothing to search by. Ask for an amount, a date or a name.",
    };
  }

  let windows: ReturnType<typeof dateWindows> = [];
  if (g.date) {
    windows = dateWindows(g.date, g.date.year === null ? await yearsWithData(ctx.accountId) : []);
  }
  const rows =
    g.date && windows.length === 0
      ? []
      : await findTransactionCandidates({
          accountId: ctx.accountId,
          userId: ctx.userId,
          amountPaise: g.amountPaise,
          windows,
          text: g.text,
          direction: g.direction,
        });
  const { ranked } = rankCandidates(g, windows, rows);
  const shown = ranked.slice(0, MAX_SHOWN);

  state.trace.push(describeSearch(g, windows));
  for (const d of g.dropped) state.trace.push(`  ignored ${d} — not in your message`);
  state.trace.push(`→ ${ranked.length} match${ranked.length === 1 ? "" : "es"}`);

  const results = shown.map((r) => {
    const ref = `T${state.refs.size + 1}`;
    state.refs.set(ref, r.row.id);
    if (ranked.length > 1) state.unpickedRefs.add(ref);
    state.txnIds.add(r.row.id);
    return {
      ref,
      date: modelDate(r.row.txnDate),
      amount: modelAmount(r.row.amountPaise),
      direction: r.row.drCr === "debit" ? "paid" : "received",
      payee: modelSafePayee(r.row),
      note: r.row.note?.slice(0, 120) ?? null,
      why: r.reasons,
    };
  });

  if (shown.length === 1) {
    state.artifacts.push({ kind: "txn", txnId: shown[0].row.id, reasons: shown[0].reasons });
    state.focus = shown[0].row.id;
  } else if (shown.length > 1) {
    state.artifacts.push({
      kind: "pick",
      txnIds: shown.map((r) => r.row.id),
      total: ranked.length,
      reasons: Object.fromEntries(shown.map((r) => [r.row.id, r.reasons])),
      then: args.purpose,
      request: ctx.message,
    });
  }

  return {
    total: ranked.length,
    results,
    next:
      ranked.length === 0
        ? "Nothing matched. Say so and offer a nearby search (another date or amount). Don't invent results."
        : ranked.length === 1
          ? "Shown to the user as a card."
          : "Several match. The app shows the user a list to pick from. Ask them to pick; don't choose.",
  };
}

async function runTool(call: FunctionCall, ctx: TurnContext, state: TurnState, groundingText: string): Promise<object> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return { error: "Arguments were not valid JSON." };
  }
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : null);

  if (call.name === "search_transactions") {
    const direction = (["debit", "credit", "any"] as const).find((d) => d === args.direction) ?? "any";
    return runSearch(
      { amount_text: s("amount_text"), date_text: s("date_text"), text: s("text"), direction, purpose: args.purpose === "act" ? "act" : "show" },
      ctx,
      state,
      groundingText,
    );
  }

  if (call.name === "get_open_balances") {
    const person = resolvePerson(s("person_name") ?? "", ctx.knownPeople).name;
    const lines = await loadOpenLinesForPerson(ctx.accountId, ctx.userId, person);
    state.trace.push(
      `open_balances(person: "${person}") → ${lines.recv.length} receivable${lines.recv.length === 1 ? "" : "s"}, ${lines.pay.length} payable${lines.pay.length === 1 ? "" : "s"}`,
    );
    const view = (l: (typeof lines.recv)[number]) => ({
      date: modelDate(l.date),
      what: modelSafePayee({ counterpartyDisplayName: null, parsedPurpose: null, label: counterpartyLabel(l.desc) }),
      outstanding: modelAmount(l.outstandingPaise),
    });
    return {
      person,
      they_owe_user: lines.recv.map(view),
      user_owes_them: lines.pay.map(view),
      they_owe_total: modelAmount(lines.recv.reduce((a, l) => a + l.outstandingPaise, 0)),
      user_owes_total: modelAmount(lines.pay.reduce((a, l) => a + l.outstandingPaise, 0)),
    };
  }

  const ref = (s("txn_ref") ?? "").trim().toUpperCase();
  const txnId = ref === "CURRENT" ? ctx.focusTxnId : state.refs.get(ref) ?? null;
  if (!txnId) {
    state.trace.push(`${call.name}(${ref || "?"}) → unknown transaction`);
    return { error: `No transaction ${ref || "given"}. Search first, or ask which one.` };
  }
  if (state.unpickedRefs.has(ref)) {
    state.trace.push(`${call.name}(${ref}) → waiting for you to pick`);
    return { error: "Several transactions matched. The user must pick one from the list first — ask them to." };
  }
  const [card] = await loadTxnCards(ctx.accountId, ctx.userId, [txnId]);
  if (!card) return { error: "That transaction isn't available." };

  let proposal: Proposal;
  if (call.name === "propose_note") {
    const note = s("note_text")?.trim();
    if (!note) return { error: "The note is empty. Ask what it should say." };
    proposal = proposeNote(card, note);
  } else if (call.name === "propose_split") {
    const mode = (["equal", "paid_for_them", "custom"] as const).find((m) => m === args.mode) ?? "custom";
    const raw = Array.isArray(args.participants) ? args.participants : [];
    const participants = raw
      .filter((p): p is { name: string; amount_text: string | null } => !!p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string")
      .slice(0, 10)
      .map((p) => {
        const paise = p.amount_text ? parseAmountToPaise(p.amount_text) : null;
        // An amount the user never wrote is left blank for them to fill.
        const grounded = paise !== null && groundIntent(
          { kind: "find_transactions", amountText: p.amount_text, dateText: null, textQuery: null, direction: "any", question: null },
          groundingText,
          ctx.today,
        ).amountPaise === paise;
        return { name: p.name, amountPaise: grounded ? paise : null };
      });
    const unsaid = participants.find((p) => !namedByUser(p.name, groundingText));
    if (unsaid) {
      state.trace.push(`resolve_person("${unsaid.name}") → not named by you`);
      return { error: `The user never named "${unsaid.name}". Ask who the split is with.` };
    }
    proposal = proposeSplit(card, { mode, participants }, ctx.knownPeople);
  } else if (call.name === "propose_category") {
    proposal = proposeCategory(card, s("category_name") ?? "", ctx.categories);
  } else if (call.name === "propose_net_settle") {
    const said = s("person_name") ?? "";
    if (!namedByUser(said, groundingText)) {
      state.trace.push(`resolve_person("${said}") → not named by you`);
      return { error: `The user never named "${said}". Ask who sent the money.` };
    }
    const person = resolvePerson(said, ctx.knownPeople).name;
    proposal = proposeNetSettle(card, person, await loadOpenLinesForPerson(ctx.accountId, ctx.userId, person));
  } else {
    return { error: `Unknown tool ${call.name}.` };
  }

  state.txnIds.add(card.id);
  state.focus = card.id;
  if (!proposal.ok) {
    state.trace.push(`${call.name}(${ref}) → not possible`);
    return { error: proposal.reason };
  }
  state.trace.push(...proposal.trace);
  state.artifacts.push({ kind: "op", draft: proposal.draft });
  state.proposed = proposal.draft.op;
  return { status: "card_shown", next: "The user reviews and applies it. Reply in one short sentence." };
}

const PROPOSED_TEXT: Record<OpDraft["op"], string> = {
  split: "Here's the split I'll create. Edit anything, then apply — nothing is saved until you do.",
  note: "Here's the note I'll add. Edit it if you like, then apply.",
  cat: "Here's the category change. Apply it when it looks right.",
  net: "Review the lines, then save — nothing is saved until you do.",
  cat_all: "Here's what would change. Apply it when it looks right.",
};

function historyItems(history: HistoryTurn[]): ResponseItem[] {
  return history.slice(-12).map((h) =>
    h.role === "user"
      ? { type: "message", role: "user", content: [{ type: "input_text", text: h.text.slice(0, 600) }] }
      : { type: "message", role: "assistant", content: [{ type: "output_text", text: h.text.slice(0, 600) }] },
  );
}

/** Finishes the messages: text + trace first, then the cards, with no duplicate txn cards. */
function assemble(state: TurnState, text: string, notice?: string): TurnMessage[] {
  const opTxns = new Set(state.artifacts.flatMap((a) => (a.kind === "op" ? [a.draft.txnId] : [])));
  const seen = new Set<string>();
  const cards = state.artifacts.filter((a) => {
    if (a.kind !== "txn") return true;
    if (opTxns.has(a.txnId) || seen.has(a.txnId)) return false;
    seen.add(a.txnId);
    return true;
  });
  return [{ kind: "ai", text, trace: state.trace.length ? state.trace : undefined, notice }, ...cards];
}

export async function runAgentTurn(ctx: TurnContext): Promise<TurnOutput> {
  const state: TurnState = { refs: new Map(), unpickedRefs: new Set(), trace: [], artifacts: [], txnIds: new Set(), focus: ctx.focusTxnId, proposed: null };
  const groundingText = [...ctx.history.filter((h) => h.role === "user").map((h) => h.text), ctx.message].join("\n");

  let access = await getChatgptAccess(ctx.userId);
  if (!access.ok) return { messages: [], txnIds: [], focusTxnId: ctx.focusTxnId, limits: null, failure: access.failure };

  const [current] = ctx.focusTxnId ? await loadTxnCards(ctx.accountId, ctx.userId, [ctx.focusTxnId]) : [];
  if (current) state.txnIds.add(current.id);
  const system = instructions({ ...ctx, focusTxnId: current?.id ?? null }, current ?? null);
  const items: ResponseItem[] = [
    ...historyItems(ctx.history),
    { type: "message", role: "user", content: [{ type: "input_text", text: ctx.message }] },
  ];
  const sessionId = crypto.randomUUID();

  let limits: AiLimits | null = null;
  let text = "";
  let retried = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    const result = await callAgentStep({
      accessToken: access.accessToken,
      accountId: access.accountId,
      model: assistantModel(),
      instructions: system,
      input: items,
      tools: AGENT_TOOLS,
      sessionId,
    });
    limits = result.limits;
    if (!result.ok) {
      const f = result.failure;
      const transient = f.kind === "timeout" || (f.kind === "unavailable" && (f.status === null || f.status >= 500));
      if (!retried && f.kind === "auth_expired") {
        retried = true;
        access = await getChatgptAccess(ctx.userId, { force: true });
        if (access.ok) {
          step--;
          continue;
        }
        return { messages: [], txnIds: [...state.txnIds], focusTxnId: state.focus, limits, failure: access.failure };
      }
      if (!retried && transient) {
        retried = true;
        step--;
        continue;
      }
      // Anything already found is still real Money data — keep it.
      const partial = state.artifacts.length > 0 ? assemble(state, "I found this before ChatGPT stopped responding.") : [];
      return { messages: partial, txnIds: [...state.txnIds], focusTxnId: state.focus, limits, failure: f };
    }

    items.push(...result.items);
    text = result.text;
    if (result.calls.length === 0) break;

    for (const call of result.calls) {
      const output = await runTool(call, ctx, state, groundingText);
      items.push({ type: "function_call_output", call_id: call.callId, output: JSON.stringify(output) });
    }
    // A card is the answer; skip another model round-trip just to say so.
    if (state.proposed) {
      text = text || PROPOSED_TEXT[state.proposed];
      break;
    }
    if (step === MAX_STEPS - 1) text = text || "I couldn't finish that. Try asking a different way.";
  }

  return {
    messages: assemble(state, text || "Done."),
    txnIds: [...state.txnIds],
    focusTxnId: state.focus,
    limits,
    failure: null,
  };
}

/** AI-free turn: find only. Used when AI is off, disconnected, or failing. */
export async function runRulesTurn(ctx: TurnContext, notice: string): Promise<TurnOutput> {
  const state: TurnState = { refs: new Map(), unpickedRefs: new Set(), trace: [], artifacts: [], txnIds: new Set(), focus: ctx.focusTxnId, proposed: null };
  const wantsChange = /\b(split|note|categor|settle|mark|tag)\w*/i.test(ctx.message);
  const intent = rulesIntent(ctx.message, ctx.today);
  if (intent.kind !== "find_transactions") {
    return {
      messages: [
        {
          kind: "ai",
          notice,
          text: wantsChange
            ? "Changes need AI reading. You can still use the buttons on a transaction card."
            : (intent.question ?? "Tell me an amount, a date or a merchant to look for."),
        },
      ],
      txnIds: [],
      focusTxnId: ctx.focusTxnId,
      limits: null,
      failure: null,
    };
  }
  const result = (await runSearch(
    { amount_text: intent.amountText, date_text: intent.dateText, text: intent.textQuery, direction: intent.direction, purpose: "show" },
    ctx,
    state,
    ctx.message,
  )) as { total?: number };
  const total = result.total ?? 0;
  const found =
    total === 0 ? "Built-in search found nothing." : total === 1 ? "Built-in search found this." : `Built-in search found ${total}. Pick one.`;
  return {
    messages: assemble(state, wantsChange ? `${found} Changes need AI reading — use the buttons on the card.` : found, notice),
    txnIds: [...state.txnIds],
    focusTxnId: state.focus,
    limits: null,
    failure: null,
  };
}
