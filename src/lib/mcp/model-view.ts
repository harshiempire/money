import type { MoneyActor } from "@/lib/assistant/actor-ops";
import { Result, Schema } from "effect";
import { shareRef, owedRef, settlementRef, transactionRef, transactionRev } from "./refs";
import { transactionView, rupees } from "./view";
import type { McpReadModel } from "./read-model";
import { McpToolError } from "./pagination";
import { personKey, closePersonNames } from "./person-names";
export { personKey } from "./person-names";

export const leftPaise = (amount: number, settled: number) => Math.max(0, amount - settled);
export function settlementVia(row: McpReadModel["settlements"][number]): "bank" | "cash" | "writeoff" | "net" {
  return row.netEventId || row.method === "offset" ? "net" : row.method;
}

/** Explicit projection: IDs are consumed here and never copied into any output. */
export function buildReadView(model: McpReadModel, actor: MoneyActor, key: Uint8Array, revKey: Uint8Array) {
  const txnById = new Map(model.transactions.map((t) => [t.id, t]));
  const txRef = (id: string | null) => id && txnById.has(id) ? transactionRef(key, actor.userId, id) : null;
  const sharesById = new Map(model.shares.map((s) => [s.id, s]));
  const owedById = new Map(model.owed.map((o) => [o.id, o]));
  const splitById = new Map(model.splits.map((s) => [s.id, s]));
  const eventById = new Map(model.netEvents.map((e) => [e.id, e]));
  const settled = (kind: "share" | "owed", id: string) => model.settlements
    .filter((s) => (kind === "share" ? s.splitParticipantId : s.owedExpenseId) === id)
    .reduce((sum, s) => sum + s.amountPaise, 0);
  const canonical = new Map<string, string>();
  for (const name of [...model.people.map((p) => p.name), ...model.shares.map((s) => s.personName), ...model.owed.map((o) => o.personName)]) {
    if (!canonical.has(personKey(name))) canonical.set(personKey(name), name.trim());
  }
  const nameFor = (name: string) => canonical.get(personKey(name)) ?? name.trim();
  const settlements = model.settlements.map((s) => {
    const share = s.splitParticipantId ? sharesById.get(s.splitParticipantId) : undefined;
    const owed = s.owedExpenseId ? owedById.get(s.owedExpenseId) : undefined;
    const inflow = s.inflowTransactionId ? txnById.get(s.inflowTransactionId) : undefined;
    return {
      ref: settlementRef(key, actor.userId, actor.accountId, s.id),
      inflow_ref: txRef(s.inflowTransactionId),
      share_ref: share ? shareRef(key, actor.userId, actor.accountId, share.id) : null,
      owed_ref: owed ? owedRef(key, actor.userId, actor.accountId, owed.id) : null,
      person: nameFor(share?.personName ?? owed?.personName ?? ""),
      amount: rupees(s.amountPaise),
      date: inflow?.txnDate ?? (s.netEventId ? eventById.get(s.netEventId)?.eventDate : undefined) ?? s.createdDate,
      via: settlementVia(s),
      for_txn_ref: share ? txRef(splitById.get(share.splitId)?.transactionId ?? null) : null,
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  const shares = model.shares.map((s) => {
    const split = splitById.get(s.splitId)!;
    const txn = txnById.get(split.transactionId)!;
    const paid = settled("share", s.id);
    const view = transactionView(txn, txRef(txn.id)!, transactionRev(revKey, actor.userId, txn.id, txn));
    return {
      ref: shareRef(key, actor.userId, actor.accountId, s.id), txn_ref: view.ref,
      person: nameFor(s.personName), date: txn.txnDate, what: txn.note ?? view.payee,
      expected: rupees(s.expectedAmountPaise), settled: rupees(paid), left: rupees(leftPaise(s.expectedAmountPaise, paid)),
    };
  });
  const owed = model.owed.map((o) => {
    const paid = settled("owed", o.id);
    return { ref: owedRef(key, actor.userId, actor.accountId, o.id), person: nameFor(o.personName), date: o.incurredDate,
      what: o.description, amount: rupees(o.amountPaise), settled: rupees(paid), left: rupees(leftPaise(o.amountPaise, paid)) };
  });
  const splits = model.splits.map((s) => ({ txn_ref: txRef(s.transactionId)!, total: rupees(s.totalPaise), your_share: rupees(s.yourSharePaise) }));
  const eventPeople = (eventId: string) => [...new Set(model.settlements.filter((s) => s.netEventId === eventId)
    .map((s) => nameFor((s.splitParticipantId ? sharesById.get(s.splitParticipantId)?.personName : owedById.get(s.owedExpenseId ?? "")?.personName) ?? "")))].sort();
  const netEvents = model.netEvents.map((e) => {
    const legs = model.settlements.filter((s) => s.netEventId === e.id);
    // Count receivable legs once; opposite payable offset legs represent the same extinguished debt.
    const receivable = legs.filter((s) => s.splitParticipantId).reduce((n, s) => n + s.amountPaise, 0);
    const payable = legs.filter((s) => s.owedExpenseId).reduce((n, s) => n + s.amountPaise, 0);
    return { person: eventPeople(e.id).join(", "), inflow_ref: txRef(e.inflowTransactionId), outflow_ref: txRef(e.outflowTransactionId), amount: rupees(Math.max(receivable, payable)) };
  });
  const transactions = model.transactions.map((t) => {
    const base = transactionView(t, txRef(t.id)!, transactionRev(revKey, actor.userId, t.id, t));
    const split = splits.find((s) => s.txn_ref === base.ref);
    const eventIndex = model.netEvents.findIndex((e) => e.inflowTransactionId === t.id || e.outflowTransactionId === t.id);
    const event = eventIndex < 0 ? null : netEvents[eventIndex];
    return { ...base,
      split: split ? { total: split.total, your_share: split.your_share,
        shares: shares.filter((s) => s.txn_ref === base.ref).map((s) => ({ ref: s.ref, person: s.person, expected: s.expected, settled: s.settled, left: s.left,
          settlements: settlements.filter((st) => st.share_ref === s.ref).map((st) => ({ ref: st.ref, amount: st.amount, date: st.date, via: st.via, inflow_ref: st.inflow_ref })) })) } : null,
      settles: settlements.filter((s) => s.inflow_ref === base.ref).map((s) => ({ ref: s.ref, amount: s.amount, share_ref: s.share_ref, owed_ref: s.owed_ref, person: s.person, for_txn_ref: s.for_txn_ref })),
      net_event: event ? { person: event.person, role: event.inflow_ref === base.ref ? "inflow" as const : "outflow" as const,
        other_ref: event.inflow_ref === base.ref ? event.outflow_ref : event.inflow_ref, amount: event.amount } : null,
      owed_expenses: owed.filter((o) => model.owed.some((raw) => raw.sourceInflowTransactionId === t.id && owedRef(key, actor.userId, actor.accountId, raw.id) === o.ref)),
    };
  });
  const people = [...canonical.values()].map((name) => {
    const same = (n: string) => personKey(n) === personKey(name);
    const personShares = model.shares.filter((s) => same(s.personName));
    const personOwed = model.owed.filter((o) => same(o.personName));
    const personSettlements = settlements.filter((s) => same(s.person));
    const seen = new Map<string, { key: string; handle: string | null; display_name: string | null; inflows: Set<string>; dates: string[] }>();
    for (const st of personSettlements) {
      const txn = transactions.find((t) => t.ref === st.inflow_ref && t.direction === "received");
      const raw = txn && model.transactions.find((t) => txRef(t.id) === txn.ref);
      if (!txn || !raw?.counterpartyKey) continue;
      const found = seen.get(raw.counterpartyKey) ?? { key: raw.counterpartyKey, handle: txn.handle, display_name: raw.displayName, inflows: new Set<string>(), dates: [] };
      found.inflows.add(txn.ref); found.dates.push(txn.date); seen.set(found.key, found);
    }
    const dates = [...shares.filter((s) => same(s.person)).map((s) => s.date), ...owed.filter((o) => same(o.person)).map((o) => o.date), ...personSettlements.map((s) => s.date)].sort();
    return { name,
      owed_to_you: rupees(personShares.reduce((n, s) => n + leftPaise(s.expectedAmountPaise, settled("share", s.id)), 0)),
      you_owe: rupees(personOwed.reduce((n, o) => n + leftPaise(o.amountPaise, settled("owed", o.id)), 0)),
      open_share_count: personShares.filter((s) => leftPaise(s.expectedAmountPaise, settled("share", s.id)) > 0).length,
      last_activity_date: dates.at(-1) ?? null,
      seen_handles: [...seen.values()].map((s) => ({ key: s.key, handle: s.handle, display_name: s.display_name, count: s.inflows.size, last_date: s.dates.sort().at(-1)! }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const payees = model.payees.map((p) => {
    const rows = model.transactions.filter((t) => t.counterpartyKey === p.key);
    const dates = rows.map((t) => t.txnDate).sort();
    return { key: p.key, kind: p.kind, handle: p.kind === "upi_handle" ? p.key : null, display_name: p.displayName,
      default_category: p.defaultCategory, is_self: p.isSelf, is_family: p.isFamily, row_count: rows.length,
      paid_total: rupees(rows.filter((t) => t.drCr === "debit").reduce((n, t) => n + t.amountPaise, 0)),
      received_total: rupees(rows.filter((t) => t.drCr === "credit").reduce((n, t) => n + t.amountPaise, 0)),
      first_date: dates[0] ?? null, last_date: dates.at(-1) ?? null,
      seen_person: people.filter((person) => person.seen_handles.some((h) => h.key === p.key)).map((person) => person.name),
    };
  }).sort((a, b) => b.row_count - a.row_count || a.key.localeCompare(b.key));
  const transactionKeys = new Map(model.transactions.map((t) => [txRef(t.id)!, t.counterpartyKey]));
  const linkedInflowRefs = new Set((model.linkedInflows ?? []).flatMap((id) => txRef(id) ? [txRef(id)!] : []));
  return { transactions, transactionKeys, linkedInflowRefs, shares, owed, settlements, splits, netEvents, people, payees };
}
export type McpReadView = ReturnType<typeof buildReadView>;

export function getTransactions(view: McpReadView, refs: readonly string[]) {
  const found = new Map(view.transactions.map((t) => [t.ref, t]));
  return { transactions: [...new Set(refs)].flatMap((ref) => found.has(ref) ? [found.get(ref)!] : []), unknown_refs: refs.filter((ref) => !found.has(ref)) };
}
export function getOpenBalances(view: McpReadView, person?: string) {
  const people = person === undefined ? view.people.filter((p) => p.owed_to_you !== "0.00" || p.you_owe !== "0.00")
    : view.people.filter((p) => personKey(p.name) === personKey(person));
  if (person !== undefined && !people.length) {
    const close = closePersonNames(view.people.map(p => p.name), person);
    throw new McpToolError(`Unknown person '${person}'. ${close.length ? `Close names: ${close.join(", ")}.` : "No close names found."}`);
  }
  return { people: people.map((p) => {
    const same = (name: string) => personKey(name) === personKey(p.name);
    const lines = [
      ...view.shares.filter((s) => same(s.person) && s.left !== "0.00").map(({ person: _p, ...s }) => ({ kind: "share" as const, ...s })),
      ...view.owed.filter((o) => same(o.person) && o.left !== "0.00").map(({ person: _p, ...o }) => ({ kind: "owed" as const, ...o })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
    const keys = new Set(p.seen_handles.map((h) => h.key));
    const unlinked = view.transactions.filter((t) => t.direction === "received" && keys.has(view.transactionKeys.get(t.ref) ?? "") && !view.linkedInflowRefs.has(t.ref) && !t.settles.length && !t.net_event && !t.owed_expenses.length)
      .sort((a, b) => b.date.localeCompare(a.date) || a.ref.localeCompare(b.ref)).slice(0, 20)
      .map((t) => ({ txn_ref: t.ref, date: t.date, amount: t.amount, handle: t.handle }));
    return { name: p.name, owed_to_you: p.owed_to_you, you_owe: p.you_owe, lines, unlinked_inflows: unlinked };
  }) };
}

const PayeeCursor = Schema.Struct({ after: Schema.String });
export function pagePayees(view: McpReadView, input: { query?: string; limit?: number; cursor?: string }) {
  const query = input.query?.trim().toLowerCase();
  const rows = view.payees.filter((p) => !query || [p.key, p.display_name].some((s) => s?.toLowerCase().includes(query)));
  let start = 0;
  if (input.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,4096}$/.test(input.cursor)) throw new Error();
      const bytes = Buffer.from(input.cursor, "base64url");
      if (bytes.toString("base64url") !== input.cursor) throw new Error();
      const decoded = Schema.decodeUnknownResult(PayeeCursor)(JSON.parse(bytes.toString("utf8")));
      if (Result.isFailure(decoded)) throw new Error();
      const index = rows.findIndex((p) => p.key === decoded.success.after);
      if (index < 0) throw new Error();
      start = index + 1;
    } catch { throw new McpToolError("That cursor is no longer available. Start with a new list_payees request."); }
  }
  const payees = rows.slice(start, start + (input.limit ?? 50));
  const last = payees.at(-1);
  return { payees, next_cursor: last && start + payees.length < rows.length ? Buffer.from(JSON.stringify({ after: last.key })).toString("base64url") : null };
}
