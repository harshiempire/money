/**
 * AI-free reading of a search message. Used when the assistant is off for
 * this user, the ChatGPT connection is down, or the limit is spent — so
 * search keeps working, just less forgivingly than the model.
 */
import { parsePartialDate } from "@/lib/dates/partial-date";
import type { Direction, FindIntent } from "./find-intent";

const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const ORD = "(?:st|nd|rd|th)?";

// Most specific first, so "26 Aug 2026" wins over "Aug".
const DATE_PATTERNS = [
  /\b\d{4}-\d{1,2}-\d{1,2}\b/i,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-](?:\d{4}|\d{2}))?\b/i,
  new RegExp(`\\b\\d{1,2}${ORD}(?:\\s+of)?\\s+(?:${MONTH})(?:,?\\s+\\d{4})?\\b`, "i"),
  new RegExp(`\\b(?:${MONTH})\\s+\\d{1,2}${ORD}(?:,?\\s+\\d{4})?\\b`, "i"),
  new RegExp(`\\b(?:${MONTH})(?:\\s+\\d{4})?\\b`, "i"),
  /\b(?:today|yesterday)\b/i,
];

const STOPWORDS = new Set(
  ("show me the transactions transaction for of on from around find a an all my i what did " +
    "spend spent paid pay received receive got with to at in rs inr rupees rupee payment payments " +
    "ones one please near about and that this was were is any money sent credited debited came")
    .split(" "),
);

// Chit-chat is answered, never searched — "hi" as a substring matches half
// the bank descriptions ("Shiva", "Hitech", …).
const SMALL_TALK =
  /^\s*(?:hi+|hey+|hello+|hola|yo|sup|good (?:morning|afternoon|evening)|thanks?|thank you|thx|ok(?:ay)?|cool|yes|no|help|what can you do)\b(?:\s+(?:there|money|all|team))?[\s!.?]*$/i;

const HELP =
  "Tell me an amount, a date or a merchant — e.g. \"₹500 on 26 Aug\" or \"Swiggy in August\".";

export function rulesIntent(message: string, today: string): FindIntent {
  if (SMALL_TALK.test(message)) {
    return { kind: "unclear", amountText: null, dateText: null, textQuery: null, direction: "any", question: HELP };
  }
  let rest = message;

  let dateText: string | null = null;
  for (const pattern of DATE_PATTERNS) {
    const m = rest.match(pattern);
    if (m && parsePartialDate(m[0], today)) {
      dateText = m[0];
      rest = rest.replace(m[0], " ");
      break;
    }
  }

  let amountText: string | null = null;
  const marked = rest.match(/(?:₹|\brs\.?|\binr)\s*\d[\d,]*(?:\.\d{1,2})?/i);
  const bare = rest.match(/\b\d[\d,]*(?:\.\d{1,2})?\b/g);
  if (marked) amountText = marked[0];
  else if (bare?.length === 1) amountText = bare[0];
  if (amountText) rest = rest.replace(amountText, " ");

  let direction: Direction = "any";
  if (/\b(?:received|got|credited|came in|refund(?:ed)?)\b/i.test(message)) direction = "credit";
  else if (/\b(?:paid|pay|spend|spent|debited|sent)\b/i.test(message)) direction = "debit";

  const words = rest
    .toLowerCase()
    .replace(/[^a-z0-9@. ]/g, " ")
    .split(/\s+/)
    // Two letters match almost everything as a substring; not a useful search.
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const textQuery = words.length > 0 && words.length <= 2 ? words.join(" ") : null;

  const hasCriteria = Boolean(amountText || dateText || textQuery);
  return {
    kind: hasCriteria ? "find_transactions" : "unclear",
    amountText,
    dateText,
    textQuery,
    direction,
    question: hasCriteria ? null : HELP,
  };
}
