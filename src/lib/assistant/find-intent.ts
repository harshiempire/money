/**
 * A transaction search as the model asks for it, and how it's checked before
 * anything uses it. The model copies spans from the user's words and never
 * does arithmetic; the server reads amounts and dates itself and drops any
 * value the user didn't actually write (small models invent years).
 */
import { parseAmountToPaise } from "@/lib/money/parse-amount";
import { parsePartialDate, stripDateSpans, type PartialDate } from "@/lib/dates/partial-date";

export type Direction = "debit" | "credit" | "any";

export interface FindIntent {
  kind: "find_transactions" | "unsupported" | "unclear";
  amountText: string | null;
  dateText: string | null;
  textQuery: string | null;
  direction: Direction;
  question: string | null;
}

export const FIND_INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "amount_text", "date_text", "text_query", "direction", "question"],
  properties: {
    kind: { type: "string", enum: ["find_transactions", "unsupported", "unclear"] },
    amount_text: { type: ["string", "null"] },
    date_text: { type: ["string", "null"] },
    text_query: { type: ["string", "null"] },
    direction: { type: "string", enum: ["debit", "credit", "any"] },
    question: { type: ["string", "null"] },
  },
} as const;

export const FIND_INTENT_INSTRUCTIONS = `You read one message from the owner of a personal finance app (Indian rupees) and extract a transaction search.
Copy spans from the message verbatim:
- amount_text: the amount exactly as written (e.g. "₹100", "100.50"), or null.
- date_text: the date exactly as written (e.g. "26 Aug", "August 26, 2026", "yesterday"), or null. Never add a year, month or day the message doesn't contain. Never convert relative dates.
- text_query: one merchant, person or description phrase from the message, or null. Not dates, amounts or filler words like "transactions".
- direction: "debit" if they paid or spent, "credit" if they received, otherwise "any".
Never do arithmetic.
If the message asks for anything other than finding transactions, kind is "unsupported".
If there is nothing to search by, kind is "unclear" and question is one short follow-up question. Otherwise question is null.`;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/** Shape check only — anything malformed is rejected, not repaired. */
export function readFindIntent(raw: unknown): FindIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kinds = ["find_transactions", "unsupported", "unclear"] as const;
  const directions = ["debit", "credit", "any"] as const;
  const kind = kinds.find((k) => k === r.kind);
  const direction = directions.find((d) => d === r.direction);
  if (!kind || !direction) return null;
  return {
    kind,
    amountText: str(r.amount_text),
    dateText: str(r.date_text),
    textQuery: str(r.text_query)?.slice(0, 100) ?? null,
    direction,
    question: str(r.question)?.slice(0, 200) ?? null,
  };
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const MONTH_NAMES = [
  ["jan", "january"], ["feb", "february"], ["mar", "march"], ["apr", "april"],
  ["may"], ["jun", "june"], ["jul", "july"], ["aug", "august"],
  ["sep", "sept", "september"], ["oct", "october"], ["nov", "november"], ["dec", "december"],
];

/** Every amount written in the message, in paise — not the digits of a date. */
function amountsIn(message: string): Set<number> {
  const found = new Set<number>();
  for (const m of stripDateSpans(message).matchAll(/(?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d+)?/gi)) {
    const paise = parseAmountToPaise(m[0]);
    if (paise !== null) found.add(paise);
  }
  return found;
}

export interface GroundedCriteria {
  amountPaise: number | null;
  date: PartialDate | null;
  text: string | null;
  direction: Direction;
  /** What the model proposed that the message didn't back up — shown, not used. */
  dropped: string[];
  /** Spans that were present but couldn't be read exactly. */
  unreadable: string[];
}

/**
 * Keeps only what the user actually wrote. Amounts are matched by value (so
 * "Rs 100" backs "₹100"); dates part by part (so an invented year is dropped
 * while the stated day and month survive).
 */
export function groundIntent(
  intent: FindIntent,
  message: string,
  today: string,
): GroundedCriteria {
  const msg = normalize(message);
  const dropped: string[] = [];
  const unreadable: string[] = [];

  let amountPaise: number | null = null;
  if (intent.amountText) {
    const paise = parseAmountToPaise(intent.amountText);
    if (paise === null) unreadable.push(intent.amountText);
    else if (amountsIn(message).has(paise)) amountPaise = paise;
    else dropped.push(`amount "${intent.amountText}"`);
  }

  let date: PartialDate | null = null;
  if (intent.dateText) {
    const parsed = parsePartialDate(intent.dateText, today);
    if (!parsed) {
      unreadable.push(intent.dateText);
    } else if (msg.includes(normalize(intent.dateText))) {
      date = parsed;
    } else {
      const numbers = new Set((msg.match(/\d+/g) ?? []).map(Number));
      // A two-digit year only counts inside a numeric date ("26/8/26") —
      // otherwise the day in "26 Aug" would vouch for an invented 2026.
      const shortYears = new Set(
        [...msg.matchAll(/\b\d{1,2}[/-]\d{1,2}[/-](\d{2})\b/g)].map((m) => 2000 + Number(m[1])),
      );
      const yearOk =
        parsed.year === null || numbers.has(parsed.year) || shortYears.has(parsed.year);
      const dayOk = parsed.day === null || numbers.has(parsed.day);
      const monthOk =
        parsed.month === null ||
        numbers.has(parsed.month) ||
        MONTH_NAMES[parsed.month - 1].some((n) => new RegExp(`\\b${n}\\b`).test(msg));
      if (!yearOk) dropped.push(`year ${parsed.year}`);
      if (!monthOk || !dayOk) dropped.push(`date "${intent.dateText}"`);
      else date = { ...parsed, year: yearOk ? parsed.year : null };
    }
  }

  let text: string | null = null;
  if (intent.textQuery) {
    if (msg.includes(normalize(intent.textQuery))) text = intent.textQuery;
    else dropped.push(`search text "${intent.textQuery}"`);
  }

  return { amountPaise, date, text, direction: intent.direction, dropped, unreadable };
}

const QTY_WORDS: Record<number, string[]> = {
  2: ["two", "twice", "double"],
  3: ["three", "thrice", "triple"],
  4: ["four"],
  5: ["five"],
  6: ["six"],
  7: ["seven"],
  8: ["eight"],
  9: ["nine"],
  10: ["ten"],
};

/** Did the user say this count ("two times", "x2", "3 plates")? Prices and dates don't count. */
export function quantityInText(qty: number, userText: string): boolean {
  const text = stripDateSpans(userText)
    .toLowerCase()
    .replace(/\d[\d,]*\.\d+|\d{1,3}(?:,\d{2,3})+/g, " ");
  if (new RegExp(`(?<![\\d.])${qty}(?![\\d.])`).test(text)) return true;
  return (QTY_WORDS[qty] ?? []).some((w) => new RegExp(`\\b${w}\\b`).test(text));
}

export interface BillItemIntent {
  label: string;
  pricePaise: number;
  qty: number;
  everyone: boolean;
  you: boolean;
  /** Other people who had it, as the user named them. */
  names: string[];
}

const EVERYONE = /^(?:everyone|everybody|all|all of us|us|we|both of us|the group|group)$/i;
const SELF_WORDS = /^(?:me|i|myself|you|self|mine)$/i;

/**
 * Checks an itemised bill the model read from the chat. Every price must be
 * one the user wrote — the model never totals, multiplies or divides; a count
 * above one must have been said; everyone on an item must have been named by
 * the user. Anything off goes back to the model to ask about, not repaired.
 */
export function groundBillItems(
  raw: unknown,
  userText: string,
): { ok: true; items: BillItemIntent[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "No items given. Ask the user to list the items and their prices." };
  }
  if (raw.length > 30) return { ok: false, error: "Too many items for one card. Ask the user to group some." };
  const written = amountsIn(userText);
  const items: BillItemIntent[] = [];
  for (const [i, entry] of raw.entries()) {
    const r = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const label = (typeof r.label === "string" && r.label.trim() ? r.label.trim() : `Item ${i + 1}`).slice(0, 40);
    const amountText = typeof r.amount_text === "string" ? r.amount_text : "";
    const pricePaise = parseAmountToPaise(amountText);
    if (pricePaise === null || pricePaise <= 0) {
      return { ok: false, error: `Couldn't read the price of ${label} ("${amountText}"). Ask the user.` };
    }
    if (!written.has(pricePaise)) {
      return {
        ok: false,
        error: `${label}: "${amountText}" isn't a price the user wrote. Copy each price exactly as written — never add, multiply or divide.`,
      };
    }
    const qty = typeof r.quantity === "number" && Number.isInteger(r.quantity) ? r.quantity : 1;
    if (qty < 1 || qty > 99) return { ok: false, error: `${label}: a count of ${qty} isn't possible. Ask how many.` };
    if (qty > 1 && !quantityInText(qty, userText)) {
      return { ok: false, error: `The user never said ${label} counts ${qty} times. Ask how many.` };
    }
    const who = Array.isArray(r.shared_by)
      ? r.shared_by.filter((w): w is string => typeof w === "string" && w.trim() !== "").map((w) => w.trim())
      : [];
    let everyone = who.length === 0;
    let you = false;
    const names: string[] = [];
    for (const w of who) {
      if (EVERYONE.test(w)) everyone = true;
      else if (SELF_WORDS.test(w)) you = true;
      else if (namedByUser(w, userText)) names.push(w);
      else return { ok: false, error: `The user never named "${w}". Ask who had ${label}.` };
    }
    items.push({ label, pricePaise, qty, everyone, you, names });
  }
  return { ok: true, items };
}

/**
 * Did the user actually name this person, now or earlier in the chat? The
 * model resolves "him" / "the person I mentioned" from history; a name that
 * appears nowhere in what the user wrote is a guess. A typed prefix counts
 * ("nit" backs "Nitin").
 */
export function namedByUser(name: string, userText: string): boolean {
  const first = name.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (first.length < 2) return false;
  const words = userText.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.some((w) => w === first || (w.length >= 3 && first.startsWith(w)));
}
