import { inflowExplanation } from "@/lib/ledger/rules/settlement-policy";
import { buildPersonBalances, personBalanceKey } from "@/lib/ledger/rules/balances";
import { readOutstanding } from "@/lib/ledger/read/money";
import type { MoneyActor } from "@/lib/assistant/actor-ops";
import { Result, Schema } from "effect";
import { shareRef, owedRef, settlementRef, transactionRef, transactionRev, splitRev } from "./refs";
import { transactionView, rupees } from "./view";
import type { McpReadModel } from "./read-model";
import { McpToolError } from "./pagination";
import { personKey, closePersonNames } from "./person-names";
import { isUncategorized } from "@/domain/spend/uncategorized";
import { suggestPersonPayees } from "./person-links";
export { personKey } from "./person-names";


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
  const balances = model.balances ?? buildPersonBalances({ people:model.people,
    shares:model.shares.map(s => { const split=splitById.get(s.splitId)!; const t=txnById.get(split.transactionId)!;
      return { id:s.id,personId:s.personId,personName:s.personName,date:t.txnDate,what:t.note ?? t.label,txnId:t.id,order:split.createdAt,amountPaise:s.expectedAmountPaise,settledRows:model.settlements.filter(st => st.splitParticipantId === s.id) }; }),
    owed:model.owed.map(o => ({ id:o.id,personId:o.personId,personName:o.personName,date:o.incurredDate,what:o.description,amountPaise:o.amountPaise,settledRows:model.settlements.filter(st => st.owedExpenseId === o.id) })),
  });
  if (!balances) throw new McpToolError("Balance exceeds the exact integer paise range.");
  const keyFor = (id: string | null | undefined, name: string) => personBalanceKey(id, name, model.people);
  const nameFor = (name: string, id?: string | null) => balances.find(p => p.key === keyFor(id,name))?.name ?? name.trim();
  const settlements = model.settlements.map((s) => {
    const share = s.splitParticipantId ? sharesById.get(s.splitParticipantId) : undefined;
    const owed = s.owedExpenseId ? owedById.get(s.owedExpenseId) : undefined;
    const inflow = s.inflowTransactionId ? txnById.get(s.inflowTransactionId) : undefined;
    return {
      ref: settlementRef(key, actor.userId, actor.accountId, s.id),
      inflow_ref: txRef(s.inflowTransactionId),
      share_ref: share ? shareRef(key, actor.userId, actor.accountId, share.id) : null,
      owed_ref: owed ? owedRef(key, actor.userId, actor.accountId, owed.id) : null,
      person: nameFor(share?.personName ?? owed?.personName ?? "", share?.personId ?? owed?.personId),
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
      person: nameFor(s.personName,s.personId), date: txn.txnDate, what: txn.note ?? view.payee,
      expected: rupees(s.expectedAmountPaise), settled: rupees(paid), left: rupees(readOutstanding(s.expectedAmountPaise, paid)),
    };
  });
  const owed = model.owed.map((o) => {
    const paid = settled("owed", o.id);
    return { ref: owedRef(key, actor.userId, actor.accountId, o.id), person: nameFor(o.personName,o.personId), date: o.incurredDate,
      what: o.description, amount: rupees(o.amountPaise), settled: rupees(paid), left: rupees(readOutstanding(o.amountPaise, paid)) };
  });
  const splits = model.splits.map((s) => ({ txn_ref: txRef(s.transactionId)!, split_rev: splitRev(revKey, actor.userId, s.transactionId, s, model.shares.filter(p => p.splitId === s.id)), total: rupees(s.totalPaise), your_share: rupees(s.yourSharePaise) }));
  const eventPeople = (eventId: string) => [...new Set(model.settlements.filter(s => s.netEventId === eventId).map(s => {
    const target = s.splitParticipantId ? sharesById.get(s.splitParticipantId) : owedById.get(s.owedExpenseId ?? "");
    return nameFor(target?.personName ?? "",target?.personId);
  }))].sort();
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
    return { ...base, person: model.payees.find(p => p.key === t.counterpartyKey)?.person ?? base.person,
      split_rev: split?.split_rev ?? "none",
      split: split ? { split_rev: split.split_rev, total: split.total, your_share: split.your_share,
        shares: shares.filter((s) => s.txn_ref === base.ref).map((s) => ({ ref: s.ref, person: s.person, expected: s.expected, settled: s.settled, left: s.left,
          settlements: settlements.filter((st) => st.share_ref === s.ref).map((st) => ({ ref: st.ref, amount: st.amount, date: st.date, via: st.via, inflow_ref: st.inflow_ref })) })) } : null,
      settles: settlements.filter((s) => s.inflow_ref === base.ref).map((s) => ({ ref: s.ref, amount: s.amount, share_ref: s.share_ref, owed_ref: s.owed_ref, person: s.person, for_txn_ref: s.for_txn_ref })),
      net_event: event ? { person: event.person, role: event.inflow_ref === base.ref ? "inflow" as const : "outflow" as const,
        other_ref: event.inflow_ref === base.ref ? event.outflow_ref : event.inflow_ref, amount: event.amount } : null,
      owed_expenses: owed.filter((o) => model.owed.some((raw) => raw.sourceInflowTransactionId === t.id && owedRef(key, actor.userId, actor.accountId, raw.id) === o.ref)),
    };
  });
  const people = balances.map((balance) => {
    const name = balance.name;
    const personShares = model.shares.filter((s) => keyFor(s.personId,s.personName) === balance.key);
    const personOwed = model.owed.filter((o) => keyFor(o.personId,o.personName) === balance.key);
    const shareRefs = new Set(personShares.map(s => shareRef(key,actor.userId,actor.accountId,s.id)));
    const owedRefs = new Set(personOwed.map(o => owedRef(key,actor.userId,actor.accountId,o.id)));
    const personSettlements = settlements.filter(s => (s.share_ref && shareRefs.has(s.share_ref)) || (s.owed_ref && owedRefs.has(s.owed_ref)));
    const seen = new Map<string, { key: string; handle: string | null; display_name: string | null; inflows: Set<string>; dates: string[] }>();
    for (const st of personSettlements) {
      const txn = transactions.find((t) => t.ref === st.inflow_ref && t.direction === "received");
      const raw = txn && model.transactions.find((t) => txRef(t.id) === txn.ref);
      if (!txn || !raw?.counterpartyKey) continue;
      const found = seen.get(raw.counterpartyKey) ?? { key: raw.counterpartyKey, handle: txn.handle, display_name: raw.displayName, inflows: new Set<string>(), dates: [] };
      found.inflows.add(txn.ref); found.dates.push(txn.date); seen.set(found.key, found);
    }
    const dates = [...shares.filter(s => shareRefs.has(s.ref)).map((s) => s.date), ...owed.filter(o => owedRefs.has(o.ref)).map((o) => o.date), ...personSettlements.map((s) => s.date)].sort();
    return { name,
      owed_to_you: rupees(balance.owedToYouPaise),
      you_owe: rupees(balance.youOwePaise),
      open_share_count: balance.openShareCount,
      last_activity_date: dates.at(-1) ?? null,
      linked_payees: (model.balances?.find(p => p.key === balance.key)?.linkedPayees ?? model.payees.filter(p => p.person && keyFor(p.personId,p.person) === balance.key))
        .map(p => ({ key:p.key,handle:p.kind === "upi_handle" ? p.key : null,display_name:p.displayName })),
      suggested_payees: suggestPersonPayees(name, model.payees, [...seen.values()].map(s => ({ key: s.key, count: s.inflows.size }))),
      seen_handles: [...seen.values()].map((s) => ({ key: s.key, handle: s.handle, display_name: s.display_name, count: s.inflows.size, last_date: s.dates.sort().at(-1)! }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    };
  });
  const personTargets = new Map(people.map((p, index) => {
    const balance = balances[index];
    return [p, { shares:new Set(balance.shares.map(s => shareRef(key,actor.userId,actor.accountId,s.id))),
      owed:new Set(balance.owed.map(o => owedRef(key,actor.userId,actor.accountId,o.id))) }];
  }));
  const payees = model.payees.map((p) => {
    const rows = model.transactions.filter((t) => t.counterpartyKey === p.key);
    const dates = rows.map((t) => t.txnDate).sort();
    return { person: p.person ?? null, key: p.key, kind: p.kind, handle: p.kind === "upi_handle" ? p.key : null, display_name: p.displayName,
      default_category: p.defaultCategory, is_self: p.isSelf, is_family: p.isFamily, row_count: rows.length,
      paid_total: rupees(rows.filter((t) => t.drCr === "debit").reduce((n, t) => n + t.amountPaise, 0)),
      received_total: rupees(rows.filter((t) => t.drCr === "credit").reduce((n, t) => n + t.amountPaise, 0)),
      first_date: dates[0] ?? null, last_date: dates.at(-1) ?? null,
      seen_person: people.filter((person) => person.seen_handles.some((h) => h.key === p.key)).map((person) => person.name),
    };
  }).sort((a, b) => b.row_count - a.row_count || a.key.localeCompare(b.key));
  const transactionKeys = new Map(model.transactions.map((t) => [txRef(t.id)!, t.counterpartyKey]));
  const linkedInflowRefs = new Set((model.linkedInflows ?? []).flatMap((id) => txRef(id) ? [txRef(id)!] : []));
  for (const t of model.transactions) {
    if (t.drCr !== "credit" || !t.residualDisposition) continue;
    const allocated = model.settlements.filter(s => s.inflowTransactionId === t.id).reduce((n, s) => n + s.amountPaise, 0);
    const sourced = model.owed.filter(o => o.sourceInflowTransactionId === t.id).reduce((n, o) => n + o.amountPaise, 0);
    if (inflowExplanation({ inflowAmountPaise: t.amountPaise, allocations: [{ amountPaise: allocated + sourced }], netReservedPaise: 0, owedSourced: false, residualDisposition: t.residualDisposition, residualAcknowledgedPaise: t.residualAcknowledgedPaise ?? null }).status === "explained") linkedInflowRefs.add(txRef(t.id)!);
  }
  const uncategorizedRefs = new Set(model.transactions.filter(isUncategorized).map(t => txRef(t.id)!));
  return { personTargets, transactions, transactionKeys, linkedInflowRefs, uncategorizedRefs, shares, owed, settlements, splits, netEvents, people, payees };
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
    const lines = [
      ...view.shares.filter((s) => view.personTargets.get(p)!.shares.has(s.ref) && s.left !== "0.00").sort((a,b) => [...view.personTargets.get(p)!.shares].indexOf(a.ref) - [...view.personTargets.get(p)!.shares].indexOf(b.ref)).map(({ person: _p, ...s }) => ({ kind: "share" as const, ...s })),
      ...view.owed.filter((o) => view.personTargets.get(p)!.owed.has(o.ref) && o.left !== "0.00").map(({ person: _p, ...o }) => ({ kind: "owed" as const, ...o })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    const unlinked = unlinkedInflows(view, p.name)
      .sort((a, b) => b.date.localeCompare(a.date) || a.ref.localeCompare(b.ref)).slice(0, 20)
      .map((t) => ({ txn_ref: t.ref, date: t.date, amount: t.amount, handle: t.handle, via: t.via }));
    return { name: p.name, owed_to_you: p.owed_to_you, you_owe: p.you_owe, lines, unlinked_inflows: unlinked };
  }) };
}

/** Confirmed links and settlement evidence only; suggested links never qualify. */
export function unlinkedInflows(view: McpReadView, person?: string) {
  return view.transactions.flatMap(t => {
    if (t.direction !== "received" || view.linkedInflowRefs.has(t.ref) || t.settles.length || t.net_event || t.owed_expenses.length) return [];
    const key = view.transactionKeys.get(t.ref);
    const people = view.people.flatMap(p => {
      if (person !== undefined && personKey(p.name) !== personKey(person)) return [];
      const via = p.linked_payees.some(h => h.key === key) ? "linked" as const : p.seen_handles.some(h => h.key === key) ? "seen" as const : null;
      return via ? [{ person: p.name, via }] : [];
    });
    return people.length ? [{ ...t, via: people.some(p => p.via === "linked") ? "linked" as const : "seen" as const, people }] : [];
  });
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
