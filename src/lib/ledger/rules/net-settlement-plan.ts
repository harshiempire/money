import { personBalanceKey } from "./balances";
import { parseRupees } from "@/lib/splits/allocation-input";
import type { NewPayableSpec } from "@/lib/net-events/legs";
type NetSettlementPlan = { ok: true; legs: NetEventLeg[] } | { ok: false; code: "invalid_input"; message: string };
const planFailure = (message: string): NetSettlementPlan => ({ ok: false, code: "invalid_input", message });
import type { ReceivableOption, PayableOption } from "@/lib/net-events/load-net-settle-data";
import type { NetEventLeg } from "@/lib/net-events/legs";
import { buildNetLegs } from "@/lib/net-events/build-legs";

export interface SettlementGroup {
  key: string;
  personKey: string;
  personName: string;
  kind: "receivable" | "payable";
  outstandingPaise: number;
  items: Array<{
    id: string;
    date: string;
    description: string;
    outstandingPaise: number;
  }>;
}
export interface SettlementPayment {
  id: string;
  date: string;
  description: string;
  personName: string | null;
  direction: "credit" | "debit";
  amountPaise: number;
}
export type SettlementSelection = Record<string, number>;


export function settlementGroups(
  receivables: ReceivableOption[],
  payables: PayableOption[],
): SettlementGroup[] {
  const groups = new Map<string, SettlementGroup>();
  const people = [...new Map([...receivables, ...payables].filter(r => r.personId).map(r => [r.personId, { id: r.personId!, name: r.personName }])).values()];
  const add = (
    kind: SettlementGroup["kind"],
    name: string,
    personId: string | null,
    item: SettlementGroup["items"][number],
  ) => {
    if (item.outstandingPaise <= 0) return;
    const person = personBalanceKey(personId, name, people);
    const key = `${kind}:${person}`;
    const group = groups.get(key) ?? {
      key,
      personKey: person,
      personName: name.trim(),
      kind,
      outstandingPaise: 0,
      items: [],
    };
    group.items.push(item);
    group.outstandingPaise += item.outstandingPaise;
    groups.set(key, group);
  };
  for (const row of receivables)
    add("receivable", row.personName, row.personId, {
      id: row.id,
      date: row.splitTransactionDate,
      description: row.splitTransactionDescription,
      outstandingPaise: row.outstandingPaise,
    });
  for (const row of payables)
    add("payable", row.personName, row.personId, {
      id: row.id,
      date: row.incurredDate,
      description: row.description,
      outstandingPaise: row.outstandingPaise,
    });
  for (const group of groups.values())
    group.items.sort(
      (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
    );
  return [...groups.values()].sort(
    (a, b) =>
      a.personName.localeCompare(b.personName) || a.kind.localeCompare(b.kind),
  );
}

export function selectionTotals(
  groups: SettlementGroup[],
  selection: SettlementSelection,
) {
  let receivable = 0,
    payable = 0;
  for (const group of groups) {
    const amount = selection[group.key] ?? 0;
    if (group.kind === "receivable") receivable += amount;
    else payable += amount;
  }
  return { receivable, payable, net: receivable - payable };
}

/** Bounded, exact suggestions only. A numerical match still needs user confirmation. */
export function suggestSettlement(
  groups: SettlementGroup[],
  expectedNet: number,
  preferredName = "",
): SettlementSelection {
  const preferred = personBalanceKey(undefined, preferredName, groups.filter(g => g.personKey.startsWith("id:")).map(g => ({ id: g.personKey.slice(3), name: g.personName })).filter((p,i,a) => a.findIndex(q => q.id === p.id) === i));
  const ordered = [...groups].sort(
    (a, b) =>
      Number(b.personKey === preferred) - Number(a.personKey === preferred),
  );
  const states = new Map<number, SettlementSelection>([[0, {}]]);
  // Bound both work and memory; on large ledgers the user can select people.
  let work = 0;
  for (const group of ordered) {
    for (const [sum, selection] of [...states]) {
      if (++work > 20000) break;
      const next =
        sum + (group.kind === "receivable" ? 1 : -1) * group.outstandingPaise;
      const picked = { ...selection, [group.key]: group.outstandingPaise };
      if (next === expectedNet) return picked;
      const previous = states.get(next);
      if (
        !previous ||
        Object.keys(picked).length < Object.keys(previous).length
      )
        states.set(next, picked);
    }
    if (work > 20000) break;
  }
  return {};
}

export function settlementFix(
  groups: SettlementGroup[],
  selection: SettlementSelection,
  expectedNet: number,
) {
  const gap = selectionTotals(groups, selection).net - expectedNet;
  if (gap === 0) return null;
  const kind = gap > 0 ? "receivable" : "payable";
  const amount = Math.abs(gap);
  const selected = groups.filter(
    (group) => group.kind === kind && (selection[group.key] ?? 0) > 0,
  );
  const target =
    selected.find((group) => selection[group.key] === amount) ??
    [...selected].reverse().find((group) => selection[group.key] > amount);
  return target
    ? {
        group: target,
        remainingOpenPaise:
          target.outstandingPaise - selection[target.key] + amount,
        next: { ...selection, [target.key]: selection[target.key] - amount },
      }
    : null;
}

/** Select an offset, keeping each side's residual open, without rounding. */
export function personSettlementSelection(
  groups: SettlementGroup[],
  name: string,
  method: "bank" | "cash" | "offset",
): SettlementSelection {
  const own = groups.filter((group) => group.personKey === personBalanceKey(undefined, name, groups.filter(g => g.personKey.startsWith("id:")).map(g => ({ id: g.personKey.slice(3), name: g.personName })).filter((p,i,a) => a.findIndex(q => q.id === p.id) === i)));
  const full = Object.fromEntries(
    own.map((group) => [group.key, group.outstandingPaise]),
  );
  if (method !== "offset") return full;
  const totals = selectionTotals(own, full);
  const offset = Math.min(totals.receivable, totals.payable);
  return Object.fromEntries(own.map((group) => [group.key, offset]));
}

export function guidedSettlementLegs(
  groups: SettlementGroup[],
  selection: SettlementSelection,
  method: "bank" | "cash" | "offset",
  payment?: SettlementPayment,
): NetSettlementPlan {
  const receivables: Array<{ id: string; paise: number; cap: number }> = [];
  const payables: Array<{ id: string; paise: number; cap: number }> = [];
  for (const group of groups) {
    let remaining = selection[group.key] ?? 0;
    if (
      !Number.isSafeInteger(remaining) ||
      remaining < 0 ||
      remaining > group.outstandingPaise
    )
      return planFailure(
        "The selected amount exceeds an open balance. Refresh and try again.",
      );
    for (const item of group.items) {
      const paise = Math.min(remaining, item.outstandingPaise);
      if (paise > 0)
        (group.kind === "receivable" ? receivables : payables).push({
          id: item.id,
          paise,
          cap: item.outstandingPaise,
        });
      remaining -= paise;
    }
  }
  const caps = new Map(
    [...receivables, ...payables].map((row) => [row.id, row.cap]),
  );
  const totals = selectionTotals(groups, selection);
  const expected =
    method === "bank" && payment
      ? payment.direction === "credit"
        ? payment.amountPaise
        : -payment.amountPaise
      : 0;
  if (method === "bank" && (!payment || totals.net !== expected))
    return planFailure("The selected balances do not match this bank payment.");
  if (method === "offset" && totals.net !== 0)
    return planFailure("Only equal amounts can cancel out.");
  let legs: NetEventLeg[];
  if (method === "cash") {
    let cash = Math.abs(totals.net);
    legs = [];
    for (const [kind, rows] of [
      ["receivable", receivables],
      ["payable", payables],
    ] as const) {
      for (const row of rows) {
        const cashPart = (
          kind === "receivable" ? totals.net > 0 : totals.net < 0
        )
          ? Math.min(cash, row.paise)
          : 0;
        cash -= cashPart;
        for (const [part, mode] of [
          [cashPart, "cash"],
          [row.paise - cashPart, "offset"],
        ] as const) {
          if (part > 0)
            legs.push(
              kind === "receivable"
                ? {
                    kind,
                    splitParticipantId: row.id,
                    amountPaise: part,
                    method: mode,
                  }
                : {
                    kind,
                    owedExpenseId: row.id,
                    amountPaise: part,
                    method: mode,
                  },
            );
        }
      }
    }
  } else {
    legs = buildNetLegs({
      receivables,
      payables,
      inflowTransactionId:
        method === "bank" && payment?.direction === "credit"
          ? payment.id
          : undefined,
      inflowAmountPaise:
        method === "bank" && payment?.direction === "credit"
          ? payment.amountPaise
          : 0,
    });
  }
  return { ok: true, legs: legs.map((leg) => ({
    ...leg,
    expectedOutstandingPaise: caps.get(
      leg.kind === "receivable" ? leg.splitParticipantId : leg.owedExpenseId!,
    ),
  })) };
}


export type SettlementMethod = "bank" | "cash" | "offset";
export type BillAmounts = Record<string, string>;
export interface SettlementBill {
  key: string;
  id: string;
  kind: "receivable" | "payable";
  person: string;
  personKey: string;
  description: string;
  date: string;
  cap: number;
  newPayable?: NewPayableSpec;
}
export interface SavedSettlementLeg {
  kind: "receivable" | "payable";
  targetId: string;
  amountPaise: number;
  method: "bank" | "cash" | "offset";
}

export const billKey = (kind: SettlementBill["kind"], id: string) => `${kind}:${id}`;
export const signedPayment = (payment: SettlementPayment) =>
  payment.direction === "credit" ? payment.amountPaise : -payment.amountPaise;

/** Restore only this event's allocations; other settlements still consume capacity. */
export function settlementBills(
  receivables: ReceivableOption[],
  payables: PayableOption[],
  existing: SavedSettlementLeg[] = [],
): SettlementBill[] {
  const restored = new Map<string, number>();
  for (const leg of existing) {
    const key = billKey(leg.kind, leg.targetId);
    restored.set(key, (restored.get(key) ?? 0) + leg.amountPaise);
  }
  return [
    ...receivables.map((r): SettlementBill => ({
      key: billKey("receivable", r.id), id: r.id, kind: "receivable",
      person: r.personName, personKey: personBalanceKey(r.personId, r.personName),
      description: r.splitTransactionDescription, date: r.splitTransactionDate,
      cap: r.outstandingPaise + (restored.get(billKey("receivable", r.id)) ?? 0),
    })),
    ...payables.map((p): SettlementBill => ({
      key: billKey("payable", p.id), id: p.id, kind: "payable",
      person: p.personName, personKey: personBalanceKey(p.personId, p.personName),
      description: p.description, date: p.incurredDate,
      cap: p.outstandingPaise + (restored.get(billKey("payable", p.id)) ?? 0),
    })),
  ].filter(b => b.cap > 0).sort((a, b) =>
    a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

export function savedBillAmounts(legs: SavedSettlementLeg[], format: (paise: number) => string): BillAmounts {
  const totals = new Map<string, number>();
  for (const leg of legs) {
    const key = billKey(leg.kind, leg.targetId);
    totals.set(key, (totals.get(key) ?? 0) + leg.amountPaise);
  }
  return Object.fromEntries([...totals].map(([key, amount]) => [key, format(amount)]));
}

export function settlementAmounts(bills: SettlementBill[], amounts: BillAmounts) {
  const errors: Record<string, string> = {};
  const selected: Array<{ bill: SettlementBill; amount: number }> = [];
  const byKey = new Map(bills.map(b => [b.key, b]));
  let receivable = 0, payable = 0;
  for (const [key, raw] of Object.entries(amounts)) {
    const bill = byKey.get(key);
    if (!bill) { errors[key] = "A selected bill is no longer available. Refresh before saving."; continue; }
    const parsed = parseRupees(raw);
    if (parsed.kind !== "paise" || parsed.paise <= 0) {
      errors[key] = "Enter a positive amount with up to two decimal places.";
      continue;
    }
    if (parsed.paise > bill.cap) {
      errors[key] = "This amount exceeds the bill’s open balance.";
      continue;
    }
    selected.push({ bill, amount: parsed.paise });
    if (bill.kind === "receivable") receivable += parsed.paise;
    else payable += parsed.paise;
  }
  return { selected, errors, valid: Object.keys(errors).length === 0,
    receivable, payable, net: receivable - payable };
}

/** An explicit user's cancel-equal-amounts action, allocated oldest bill first. */
export function equalOffsetAmounts(bills: SettlementBill[], format: (paise: number) => string): BillAmounts {
  const sum = (kind: SettlementBill["kind"]) => bills.filter(b => b.kind === kind).reduce((n, b) => n + b.cap, 0);
  const overlap = Math.min(sum("receivable"), sum("payable"));
  const amounts: BillAmounts = {};
  for (const kind of ["receivable", "payable"] as const) {
    let remaining = overlap;
    for (const bill of [...bills].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key))) {
      if (bill.kind !== kind || remaining <= 0) continue;
      const amount = Math.min(bill.cap, remaining);
      amounts[bill.key] = format(amount);
      remaining -= amount;
    }
  }
  return amounts;
}

/** Exact individual bills, never an automatic redistribution across a person's bills. */
export function settlementFlowLegs(
  bills: SettlementBill[], amounts: BillAmounts,
  method: SettlementMethod, payment?: SettlementPayment,
): NetSettlementPlan {
  const t = settlementAmounts(bills, amounts);
  if (!t.valid) return planFailure(Object.values(t.errors)[0]);
  if (!t.selected.length) return planFailure("Choose at least one bill.");
  if (method === "bank" && (!payment || t.net !== signedPayment(payment)))
    return planFailure("The selected bills do not match the bank payment.");
  if (method === "offset" && t.net !== 0)
    return planFailure("Only equal amounts can cancel out.");
  if (method === "cash" && t.net === 0)
    return planFailure("No cash changed hands. Choose cancel out instead.");
  let legs: NetEventLeg[];
  if (method === "cash") {
    let remaining = Math.abs(t.net);
    legs = [];
    for (const { bill, amount } of t.selected) {
      const cashSide = bill.kind === "receivable" ? t.net > 0 : t.net < 0;
      const cash = cashSide ? Math.min(remaining, amount) : 0;
      remaining -= cash;
      for (const [amountPaise, mode] of [[cash, "cash"], [amount - cash, "offset"]] as const) {
        if (!amountPaise) continue;
        legs.push(bill.kind === "receivable"
          ? { kind: "receivable", splitParticipantId: bill.id, amountPaise, method: mode }
          : bill.newPayable
            ? { kind: "payable", newPayable: bill.newPayable, amountPaise, method: mode }
            : { kind: "payable", owedExpenseId: bill.id, amountPaise, method: mode });
      }
    }
  } else {
    const own = t.selected.filter(r => r.bill.kind === "payable");
    legs = buildNetLegs({
      receivables: t.selected.filter(r => r.bill.kind === "receivable").map(r => ({ id: r.bill.id, paise: r.amount })),
      payables: own.filter(r => !r.bill.newPayable).map(r => ({ id: r.bill.id, paise: r.amount })),
      newPayables: own.filter(r => r.bill.newPayable).map(r => ({ spec: r.bill.newPayable!, paise: r.amount })),
      inflowTransactionId: method === "bank" && payment?.direction === "credit" ? payment.id : undefined,
      inflowAmountPaise: method === "bank" && payment?.direction === "credit" ? payment.amountPaise : 0,
    });
  }
  const caps = new Map(bills.map(b => [b.key, b.cap]));
  return { ok: true, legs: legs.map(leg => {
    const key = leg.kind === "receivable" ? billKey(leg.kind, leg.splitParticipantId)
      : leg.owedExpenseId ? billKey(leg.kind, leg.owedExpenseId) : null;
    return key ? { ...leg, expectedOutstandingPaise: caps.get(key) } : leg;
  }) };
}
