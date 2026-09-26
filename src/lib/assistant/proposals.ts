/**
 * Builds the prefilled pending cards. A proposal is only ever a draft for the
 * user to edit and apply — these functions never write. Inputs are rows the
 * server already loaded for the signed-in user, so everything shown is Money
 * data; the model only supplied names, the mode and verbatim amounts.
 */
import { equalShares, fillReceivablesLargestFirst, resolvePerson, rupeesString } from "./card-math";
import type { CategoryLite, NetLine, OpDraft, TxnCardData } from "./types";

export type Proposal = { ok: true; draft: OpDraft; trace: string[] } | { ok: false; reason: string };

const SELF = new Set(["me", "i", "myself", "you", "self", "us", "we"]);

export function proposeSplit(
  card: TxnCardData,
  input: {
    mode: "equal" | "paid_for_them" | "custom";
    participants: Array<{ name: string; amountPaise: number | null }>;
  },
  knownPeople: string[],
): Proposal {
  if (card.drCr !== "debit") {
    return { ok: false, reason: "Only a payment you made can be split. Money you received can be net settled instead." };
  }
  if (card.split) {
    return {
      ok: false,
      reason: "This payment already has a split. Edit it from the Split button in the table so existing settlements aren't lost.",
    };
  }

  const people = input.participants
    .filter((p) => p.name.trim() && !SELF.has(p.name.trim().toLowerCase()))
    .map((p) => ({ ...resolvePerson(p.name, knownPeople), amountPaise: p.amountPaise }));
  const trace = people.map((p) =>
    p.known ? `resolve_person("${p.name}") → ${p.name} · People` : `resolve_person("${p.name}") → new person`,
  );

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
