/**
 * Builds the prefilled pending cards. A proposal is only ever a draft for the
 * user to edit and apply — these functions never write. Inputs are rows the
 * server already loaded for the signed-in user, so everything shown is Money
 * data; the model only supplied names, the mode and verbatim amounts.
 */
import { formatPaise } from "@/lib/format";
import {
  YOU,
  equalShares,
  fillReceivablesLargestFirst,
  itemizedShares,
  resolvePerson,
  rupeesString,
  type BillItem,
} from "./card-math";
import type { BillItemIntent } from "./find-intent";
import type { CategoryLite, NetLine, OpDraft, SplitItems, TxnCardData } from "./types";

/** `say` replaces the stock reply when the card needs explaining. */
export type Proposal = { ok: true; draft: OpDraft; trace: string[]; say?: string } | { ok: false; reason: string };

const SELF = new Set(["me", "i", "myself", "you", "self", "us", "we"]);

function cannotSplit(card: TxnCardData): Proposal | null {
  if (card.drCr !== "debit") {
    return { ok: false, reason: "Only a payment you made can be split. Money you received can be net settled instead." };
  }
  if (card.split) {
    return {
      ok: false,
      reason: "This payment already has a split. Edit it from the Split button in the table so existing settlements aren't lost.",
    };
  }
  return null;
}

const resolveTrace = (p: { name: string; known: boolean }) =>
  p.known ? `resolve_person("${p.name}") → ${p.name} · People` : `resolve_person("${p.name}") → new person`;

export function proposeSplit(
  card: TxnCardData,
  input: {
    mode: "equal" | "paid_for_them" | "custom";
    participants: Array<{ name: string; amountPaise: number | null }>;
  },
  knownPeople: string[],
): Proposal {
  const blocked = cannotSplit(card);
  if (blocked) return blocked;

  const people = input.participants
    .filter((p) => p.name.trim() && !SELF.has(p.name.trim().toLowerCase()))
    .map((p) => ({ ...resolvePerson(p.name, knownPeople), amountPaise: p.amountPaise }));
  const trace = people.map(resolveTrace);

  const total = card.amountPaise;
  let yourShare = "";
  let parts: Array<{ name: string; amt: string; known: boolean }>;

  if (people.length === 0) {
    parts = [{ name: "", amt: "", known: false }];
  } else if (input.mode === "equal") {
    const { yours, each } = equalShares(total, people.length);
    yourShare = rupeesString(yours);
    parts = people.map((p) => ({ name: p.name, amt: rupeesString(each), known: p.known }));
    trace.push(`prepare_split(${rupeesString(total)}, equal, ${people.length + 1} people)`);
  } else if (input.mode === "paid_for_them") {
    const each = Math.floor(total / people.length);
    const first = total - each * (people.length - 1);
    yourShare = "0.00";
    parts = people.map((p, i) => ({ name: p.name, amt: rupeesString(i === 0 ? first : each), known: p.known }));
    trace.push(`prepare_split(${rupeesString(total)}, paid for them, your share 0)`);
  } else {
    parts = people.map((p) => ({
      name: p.name,
      amt: p.amountPaise !== null ? rupeesString(p.amountPaise) : "",
      known: p.known,
    }));
    trace.push(`prepare_split(${rupeesString(total)}, custom amounts)`);
  }

  return {
    ok: true,
    draft: { op: "split", txnId: card.id, totalPaise: total, yourShare, parts },
    trace,
  };
}

/**
 * A split worked out from the user's itemised bill. The shares are computed
 * here in paise from prices the user wrote; the card lists the items so the
 * user can see how each share came about, and flags any gap between the items
 * and the payment instead of hiding it in someone's share.
 */
export function proposeItemizedSplit(
  card: TxnCardData,
  input: { people: string[]; items: BillItemIntent[] },
  knownPeople: string[],
): Proposal {
  const blocked = cannotSplit(card);
  if (blocked) return blocked;

  // Everyone named — in the people list or on an item — is one participant.
  const people: Array<{ name: string; known: boolean }> = [];
  const indexOf = (said: string) => {
    const person = resolvePerson(said, knownPeople);
    const at = people.findIndex((p) => p.name.toLowerCase() === person.name.toLowerCase());
    if (at >= 0) return at;
    people.push(person);
    return people.length - 1;
  };
  for (const name of input.people) {
    if (name.trim() && !SELF.has(name.trim().toLowerCase())) indexOf(name);
  }
  const bill: BillItem[] = input.items.map((it) => ({
    pricePaise: it.pricePaise,
    qty: it.qty,
    sharers: it.everyone ? [] : [...(it.you ? [YOU] : []), ...it.names.map(indexOf)],
  }));
  if (people.length === 0) {
    return { ok: false, reason: "Nobody else is named on this bill. Ask who shared it." };
  }

  const { yours, each, itemsTotal } = itemizedShares(bill, people.length);
  const total = card.amountPaise;
  const yourShare = rupeesString(yours);
  const parts = people.map((p, i) => ({ name: p.name, amt: rupeesString(each[i]), known: p.known }));
  const items: SplitItems = {
    lines: input.items.map((it, i) => ({
      label: it.label,
      pricePaise: it.pricePaise,
      qty: it.qty,
      sharedBy: it.everyone
        ? "everyone"
        : bill[i].sharers.map((s) => (s === YOU ? "you" : people[s].name)),
    })),
    itemsTotalPaise: itemsTotal,
    worked: { yourShare, amts: parts.map((p) => p.amt) },
  };

  const gap = total - itemsTotal;
  const say =
    gap === 0
      ? "Here's the split worked out from your items — they add up to the payment exactly. Edit anything, then apply."
      : gap > 0
        ? `Your items come to ${formatPaise(itemsTotal)}, but the payment was ${formatPaise(total)} — ${formatPaise(gap)} isn't assigned yet. Add it to someone's share on the card, or tell me who covers it.`
        : `Your items come to ${formatPaise(itemsTotal)}, ${formatPaise(-gap)} more than the payment of ${formatPaise(total)}. Check the prices, or edit the shares on the card.`;

  return {
    ok: true,
    draft: { op: "split", txnId: card.id, totalPaise: total, yourShare, parts, items },
    trace: [
      ...people.map(resolveTrace),
      `prepare_split(${rupeesString(total)}, ${input.items.length} items = ${rupeesString(itemsTotal)}, ${people.length + 1} people)`,
    ],
    say,
  };
}

export function proposeNote(card: TxnCardData, noteText: string): Proposal {
  return {
    ok: true,
    draft: { op: "note", txnId: card.id, currentNote: card.note, note: noteText.trim().slice(0, 500) },
    trace: [],
  };
}

export function proposeCategory(card: TxnCardData, said: string, categories: CategoryLite[]): Proposal {
  const lower = said.trim().toLowerCase();
  const exact = categories.find((c) => c.name.toLowerCase() === lower);
  const partial = categories.filter((c) => c.name.toLowerCase().includes(lower));
  const match = exact ?? (lower.length >= 3 && partial.length === 1 ? partial[0] : null);
  if (!match) {
    return {
      ok: false,
      reason: `There's no category called "${said}". Categories: ${categories.map((c) => c.name).join(", ")}.`,
    };
  }
  return {
    ok: true,
    draft: { op: "cat", txnId: card.id, currentCategoryId: card.categoryId, categoryId: match.id },
    trace: [`resolve_category("${said}") → ${match.name}`],
  };
}

export function proposeNetSettle(
  card: TxnCardData,
  person: string,
  lines: { recv: NetLine[]; pay: NetLine[] },
): Proposal {
  if (card.drCr !== "credit") {
    return { ok: false, reason: "Net settle here works on money you received. Pick the incoming payment." };
  }
  if (card.netEventId) {
    return { ok: false, reason: "That payment is already net settled. Change it from Net ✓ in the table." };
  }
  if (lines.recv.length === 0 && lines.pay.length === 0) {
    return { ok: false, reason: `Nothing is open between you and ${person} — no unsettled splits or payables.` };
  }
  const pay = lines.pay.map((l) => ({ ...l, val: rupeesString(l.outstandingPaise) }));
  const recv = fillReceivablesLargestFirst(card.amountPaise, lines.recv, pay);
  return {
    ok: true,
    draft: {
      op: "net",
      txnId: card.id,
      inflowPaise: card.amountPaise,
      eventDate: card.txnDate,
      person,
      recv,
      pay,
      note: `Settled up with ${person}`,
    },
    trace: [
      `open_balances(person: "${person}") → ${lines.recv.length} receivable${lines.recv.length === 1 ? "" : "s"}, ${lines.pay.length} payable${lines.pay.length === 1 ? "" : "s"}`,
    ],
  };
}
