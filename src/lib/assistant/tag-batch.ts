/**
 * Drafting a month of category suggestions. Nothing here writes.
 *
 * A row is one of two kinds. "suggest" is a category the user can approve.
 * "needs_answer" is reserved for a later questions step and is never emitted
 * by this phase, so a future list can add those rows without a new envelope.
 *
 * Selection keeps every uncategorized row in the month, including ones flagged
 * as transfers. A row that already has a category is left out, transfer or not.
 */
import { MONTH_ABBR, modelAmount, modelDate, modelSafePayee, modelSafeText } from "./model-view";
import type { CategoryLite } from "./types";

export const TAG_CHUNK_SIZE = 12;

export interface UntaggedMonth {
  year: number;
  month: number;
  count: number;
}

export interface ContextNote {
  id: string;
  body: string;
}

export type TagConfidence = "high" | "medium" | "low" | "none";
export type TagSource = "history" | "note" | "model" | "conflict" | "none";
export type TagRowKind = "suggest" | "needs_answer";

/** A transaction reduced to what tagging needs. Bank text stays on `label` and never goes to the model. */
export interface TagFact {
  id: string;
  txnDate: string;
  amountPaise: number;
  drCr: "debit" | "credit";
  channel: string;
  categoryId: string | null;
  isTransfer: boolean;
  counterpartyId: string | null;
  displayName: string | null;
  parsedPurpose: string | null;
  label: string;
  note: string | null;
  /** Bank reference. The same value can appear on a debit and its reversal. */
  bankRefId: string;
  defaultCategoryId: string | null;
}

export interface TagChoice {
  categoryId: string;
  name: string;
}

export interface TagDraftRow {
  kind: TagRowKind;
  txnId: string;
  ref: string;
  suggestedCategoryId: string | null;
  confidence: TagConfidence;
  reason: string;
  source: TagSource;
  choices: TagChoice[];
  transfer: boolean;
  /** Present so the review can offer to remember a payee default. The model payload drops it. */
  counterpartyId: string | null;
}

export interface ModelGuess {
  ref: string;
  categoryName: string | null;
  confidence: TagConfidence;
  reason: string;
}

export interface ModelTagRow {
  ref: string;
  date: string;
  amount: string;
  direction: "paid" | "received";
  channel: string;
  payee: string;
  note: string | null;
  transfer: boolean;
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const CHANNEL_LABEL: Record<string, string> = {
  upi: "UPI",
  imps: "IMPS",
  neft: "NEFT",
  rtgs: "RTGS",
  cheque: "Cheque",
  cash: "Cash",
  card: "Card",
  opening: "Opening",
  other: "Other",
};

const STOP = new Set([
  "the", "a", "an", "to", "for", "of", "and", "or", "on", "in", "at", "my", "me",
  "this", "that", "with", "from", "was", "were", "is", "it", "you", "your",
]);

export function monthTitle(year: number, month: number): string {
  return `${MONTH_ABBR[month - 1] ?? "Month"} ${year}`;
}

export function shortMonthDay(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d} ${MONTH_ABBR[Number(m) - 1] ?? ""}`.trim();
}

/** Latest month in the list, which the caller sorts newest first. */
export function defaultTagMonth<T extends { year: number; month: number }>(months: T[]): T | null {
  return months[0] ?? null;
}

export function parseMonthName(name: string): number | null {
  const n = name.trim().toLowerCase();
  const full = MONTH_NAMES.indexOf(n);
  if (full >= 0) return full + 1;
  const abbr = MONTH_ABBR.findIndex((m) => m.toLowerCase() === n);
  return abbr >= 0 ? abbr + 1 : null;
}

/**
 * "tag June" or "categorize June 2026". Year omitted picks the latest matching
 * month the account still has untagged, otherwise the year of `today`.
 */
export function parseTagRequest(
  message: string,
  available: Array<{ year: number; month: number }>,
  today: string,
): { year: number; month: number } | null {
  const match = message
    .trim()
    .match(
      /^(?:please\s+)?(?:tag|categorize|categorise)(?:\s+(?:all|everything))?(?:\s+(?:of|in|for|from))?\s+([a-z]+)(?:\s+(20\d{2}))?[.!?]?$/i,
    );
  if (!match) return null;
  const month = parseMonthName(match[1]);
  if (!month) return null;
  if (match[2]) return { year: Number(match[2]), month };
  const found = [...available]
    .sort((a, b) => b.year - a.year || b.month - a.month)
    .find((m) => m.month === month);
  if (found) return { year: found.year, month };
  const todayYear = Number(today.slice(0, 4));
  const todayMonth = Number(today.slice(5, 7));
  return { year: month <= todayMonth ? todayYear : todayYear - 1, month };
}

/**
 * Untagged rows for one calendar month. Categorized rows are dropped, including
 * transfers that already have a category. Duplicate transaction ids collapse.
 * Shared bank reference ids do not.
 */
export function selectUntagged(rows: TagFact[], year: number, month: number): TagFact[] {
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const seen = new Set<string>();
  const out: TagFact[] = [];
  for (const row of rows) {
    if (!row.txnDate.startsWith(prefix) || row.categoryId || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  out.sort((a, b) => a.txnDate.localeCompare(b.txnDate) || a.id.localeCompare(b.id));
  return out;
}

export function chunkSlice<T>(rows: T[], offset: number, size = TAG_CHUNK_SIZE): { slice: T[]; nextOffset: number | null } {
  const start = Math.max(0, offset);
  const slice = rows.slice(start, start + size);
  const next = start + slice.length;
  return { slice, nextOffset: next >= rows.length ? null : next };
}

export function refForIndex(index: number): string {
  return `T${index + 1}`;
}

function tokens(value: string | null): string[] {
  const safe = modelSafeText(value, 200);
  if (!safe) return [];
  return [...new Set(safe.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)))];
}

function categoryName(categories: CategoryLite[], id: string): string {
  return categories.find((c) => c.id === id)?.name ?? "a category";
}

function safePayee(row: TagFact): string {
  return modelSafePayee({
    counterpartyDisplayName: row.displayName,
    parsedPurpose: row.parsedPurpose,
    label: row.label,
  });
}

function samePayee(target: TagFact, other: TagFact): boolean {
  if (target.counterpartyId && other.counterpartyId) return target.counterpartyId === other.counterpartyId;
  const payee = safePayee(target);
  if (payee === "Payee") return false;
  return safePayee(other) === payee;
}

export type HistoryCall =
  | { kind: "match"; categoryId: string; confidence: "high" | "medium"; support: number; reason: string }
  | { kind: "conflict"; choices: TagChoice[]; reason: string }
  | { kind: "note"; categoryId: string; confidence: "high" | "medium"; reason: string }
  | { kind: "none" };

/**
 * History first, then a note that names a category. Fuzzy note overlap is only
 * a medium signal. Channel alone never decides a category.
 */
export function readHistory(target: TagFact, past: TagFact[], categories: CategoryLite[]): HistoryCall {
  const counts = new Map<string, number>();
  let fromDefaultOnly = false;
  for (const row of past) {
    if (!row.categoryId || row.id === target.id || !samePayee(target, row)) continue;
    counts.set(row.categoryId, (counts.get(row.categoryId) ?? 0) + 1);
  }
  if (counts.size === 0 && target.defaultCategoryId) {
    counts.set(target.defaultCategoryId, 1);
    fromDefaultOnly = true;
  } else if (target.defaultCategoryId && counts.size > 0 && !counts.has(target.defaultCategoryId)) {
    counts.set(target.defaultCategoryId, 1);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length > 1) {
    const choices = ranked.slice(0, 4).map(([categoryId]) => ({ categoryId, name: categoryName(categories, categoryId) }));
    const listed = choices.map((c) => c.name).join(" and ");
    return {
      kind: "conflict",
      choices,
      reason: `This payee was tagged ${listed} before. Choose one.`,
    };
  }
  if (ranked.length === 1) {
    const [categoryId, support] = ranked[0];
    const name = categoryName(categories, categoryId);
    const payee = safePayee(target);
    const who = payee === "Payee" ? "this payee" : payee;
    const channel = CHANNEL_LABEL[target.channel] ?? target.channel;
    const confidence: "high" | "medium" = !fromDefaultOnly && support >= 2 ? "high" : "medium";
    const reason = fromDefaultOnly
      ? `${channel} · ${who} defaults to ${name}`
      : `${channel} · ${support} earlier ${who} payment${support === 1 ? "" : "s"} tagged ${name}`;
    return { kind: "match", categoryId, confidence, support, reason };
  }

  const note = modelSafeText(target.note);
  if (note) {
    const named = categories.filter((c) => new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(note));
    if (named.length === 1) {
      return { kind: "note", categoryId: named[0].id, confidence: "high", reason: `Your note names ${named[0].name}` };
    }
    const mine = tokens(note);
    if (mine.length > 0) {
      const scores = new Map<string, number>();
      for (const row of past) {
        if (!row.categoryId || row.id === target.id) continue;
        const shared = tokens(row.note).filter((t) => mine.includes(t) && t.length >= 4).length;
        if (shared === 0) continue;
        scores.set(row.categoryId, (scores.get(row.categoryId) ?? 0) + shared);
      }
      const best = [...scores.entries()].sort((a, b) => b[1] - a[1]);
      if (best.length === 1 || (best.length > 1 && best[0][1] >= best[1][1] + 2 && best[0][1] >= 2)) {
        const name = categoryName(categories, best[0][0]);
        return { kind: "note", categoryId: best[0][0], confidence: "medium", reason: `Your note looks like earlier ${name} payments` };
      }
    }
  }
  return { kind: "none" };
}

export function rowForModel(row: TagFact, ref: string): ModelTagRow {
  return {
    ref,
    date: modelDate(row.txnDate),
    amount: modelAmount(row.amountPaise),
    direction: row.drCr === "debit" ? "paid" : "received",
    channel: row.channel,
    payee: safePayee(row),
    note: modelSafeText(row.note),
    transfer: row.isTransfer,
  };
}

const CONFIDENCE = new Set<TagConfidence>(["high", "medium", "low", "none"]);

/** The submit_tag_suggestions payload. Bad JSON and odd rows become an empty list. */
export function parseModelGuesses(raw: unknown): ModelGuess[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== "object") return [];
  const suggestions = (parsed as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(suggestions)) return [];
  const out: ModelGuess[] = [];
  for (const item of suggestions) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.ref !== "string") continue;
    const confidence = rec.confidence;
    out.push({
      ref: rec.ref,
      categoryName: typeof rec.category_name === "string" ? rec.category_name : null,
      confidence: confidence === "high" || confidence === "medium" || confidence === "low" || confidence === "none" ? confidence : "none",
      reason: typeof rec.reason === "string" ? rec.reason : "",
    });
  }
  return out;
}

/** First guess per ref wins. Unknown refs and a second copy of a ref are dropped. */
export function indexGuesses(guesses: ModelGuess[], knownRefs: ReadonlySet<string>): Map<string, ModelGuess> {
  const map = new Map<string, ModelGuess>();
  for (const guess of guesses) {
    const ref = guess.ref.trim().toUpperCase();
    if (!knownRefs.has(ref) || map.has(ref)) continue;
    const confidence = CONFIDENCE.has(guess.confidence) ? guess.confidence : "none";
    map.set(ref, { ...guess, ref, confidence });
  }
  return map;
}

function resolveCategory(name: string | null, categories: CategoryLite[]): CategoryLite | null {
  if (!name?.trim()) return null;
  const lower = name.trim().toLowerCase();
  return categories.find((c) => c.name.toLowerCase() === lower) ?? null;
}

export function buildDraftRow(
  row: TagFact,
  ref: string,
  history: HistoryCall,
  guess: ModelGuess | undefined,
  categories: CategoryLite[],
): TagDraftRow {
  const base = {
    kind: "suggest" as const,
    txnId: row.id,
    ref,
    transfer: row.isTransfer,
    counterpartyId: row.counterpartyId,
    choices: [] as TagChoice[],
  };
  if (history.kind === "conflict") {
    return {
      ...base,
      suggestedCategoryId: null,
      confidence: "none",
      reason: history.reason,
      source: "conflict",
      choices: history.choices,
    };
  }
  if (history.kind === "match" || history.kind === "note") {
    return {
      ...base,
      suggestedCategoryId: history.categoryId,
      confidence: history.confidence,
      reason: history.reason,
      source: history.kind === "match" ? "history" : "note",
    };
  }
  const category = resolveCategory(guess?.categoryName ?? null, categories);
  const confidence = guess?.confidence ?? "none";
  if (!category || confidence === "none") {
    return {
      ...base,
      suggestedCategoryId: null,
      confidence: "none",
      reason: row.isTransfer ? "Flagged as a transfer. No suggestion." : "No suggestion",
      source: "none",
    };
  }
  const reason = modelSafeText(guess?.reason, 80) ?? "Suggested from the amount, channel and payee";
  return {
    ...base,
    suggestedCategoryId: category.id,
    confidence,
    reason,
    source: "model",
  };
}

/** High confidence from history or a note is the only row checked up front. */
export function rowPreselected(row: TagDraftRow): boolean {
  return (
    row.kind === "suggest" &&
    row.confidence === "high" &&
    (row.source === "history" || row.source === "note") &&
    row.suggestedCategoryId !== null &&
    row.choices.length === 0
  );
}

export function confidenceLabel(confidence: TagConfidence): string {
  if (confidence === "high") return "High";
  if (confidence === "medium") return "Medium";
  if (confidence === "low") return "needs your input";
  return "—";
}

export interface TagChunkDraft {
  total: number;
  nextOffset: number | null;
  rows: TagDraftRow[];
  /** Rows in this chunk that history and notes did not decide. A model may fill these; it is not called here. */
  needsModel: ModelTagRow[];
}

/**
 * One chunk of a month draft. `guesses` are optional and only apply to rows
 * history and notes left open. Passing none leaves those rows as "no suggestion".
 */
export function assembleTagChunk(input: {
  untagged: TagFact[];
  past: TagFact[];
  categories: CategoryLite[];
  year: number;
  month: number;
  offset: number;
  guesses?: ModelGuess[];
}): TagChunkDraft {
  const selected = selectUntagged(input.untagged, input.year, input.month);
  const { slice, nextOffset } = chunkSlice(selected, input.offset, TAG_CHUNK_SIZE);
  const start = Math.max(0, input.offset);
  const known = new Set(slice.map((_, i) => refForIndex(start + i)));
  const guesses = indexGuesses(input.guesses ?? [], known);
  const needsModel: ModelTagRow[] = [];
  const rows = slice.map((row, i) => {
    const ref = refForIndex(start + i);
    const history = readHistory(row, input.past, input.categories);
    if (history.kind === "none") needsModel.push(rowForModel(row, ref));
    return buildDraftRow(row, ref, history, history.kind === "none" ? guesses.get(ref) : undefined, input.categories);
  });
  return { total: selected.length, nextOffset, rows, needsModel };
}

export function standingNotesForModel(bodies: string[]): string[] {
  const out: string[] = [];
  for (const body of bodies) {
    const safe = modelSafeText(body, 240);
    if (safe) out.push(safe);
    if (out.length >= 30) break;
  }
  return out;
}

export type StandingNoteProposal = { ok: true; body: string } | { ok: false; reason: string };

/** A standing note the user can apply later. A handle or a long number is refused whole. */
export function proposeStandingNote(body: string): StandingNoteProposal {
  const text = modelSafeText(body, 500);
  if (!text) {
    return {
      ok: false,
      reason: "That note includes a handle or a long number, so it can't be saved. Ask the user to rephrase it without those.",
    };
  }
  return { ok: true, body: text };
}
