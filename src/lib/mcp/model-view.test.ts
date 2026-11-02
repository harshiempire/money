import { expect, test } from "bun:test";
import { Schema } from "effect";
import { fixtureView, readFixture } from "./read-fixtures";
import { getTransactions, getOpenBalances, pagePayees } from "./model-view";
import { GetTransactionsOutput, PeopleOutput, OpenBalancesOutput, PayeesOutput } from "./read-schemas";
import { buildOverview } from "./overview";

test("transaction details expose shares, bank/cash/writeoff/net allocations, sourced owed expenses and unknown refs without IDs", () => {
  const view = fixtureView();
  const bill = view.transactions.find((t) => t.amount === "567.00")!;
  expect(bill.split).toMatchObject({ total: "567.00", your_share: "293.00", shares: [{ person: "Kiran", expected: "274.00", settled: "80.00", left: "194.00" }] });
  expect(bill.split!.shares[0].ref).toStartWith("shr_");
  expect(bill.split!.shares[0].settlements.map((s) => s.via)).toEqual(["bank", "net", "net"]);
  const old = view.transactions.find((t) => t.date === "2026-04-20")!;
  expect(old.split!.shares[0]).toMatchObject({ settled: "4.00", left: "2.00" });
  expect(old.split!.shares[0].settlements.map((s) => s.via)).toEqual(["cash", "writeoff", "bank"]);
  const inflow = view.transactions.find((t) => t.date === "2026-08-01")!;
  expect(inflow.settles).toHaveLength(2);
  expect(inflow.settles[0].for_txn_ref).toStartWith("txn_");
  const owed = view.transactions.find((t) => t.date === "2026-08-02")!.settles[0];
  expect(owed.share_ref).toBeNull(); expect(owed.owed_ref).toStartWith("owe_"); expect(owed.for_txn_ref).toBeNull();
  expect(view.transactions.find((t) => t.date === "2026-08-04")!.net_event).toEqual({ person: "Kiran", role: "inflow", other_ref: null, amount: "30.00" });
  expect(view.transactions.find((t) => t.date === "2026-08-05")!.owed_expenses).toMatchObject([{ person: "Kiran", amount: "100.00" }]);
  const response = getTransactions(view, [bill.ref, "unknown", bill.ref]);
  expect(response.transactions).toHaveLength(1); expect(response.unknown_refs).toEqual(["unknown"]);
  expect(Schema.is(GetTransactionsOutput)(response)).toBe(true);
  expect(JSON.stringify(response)).not.toContain("private-");
});

test("people merge saved and historical trimmed names, learn distinct inflows, and match overview balances", () => {
  const model = readFixture(); const view = fixtureView(model);
  expect(view.people.map((p) => p.name)).toEqual(["Kiran", "No Activity", "Only Historical", "Ravi Teja"]);
  const kiran = view.people[0];
  expect(kiran).toMatchObject({ owed_to_you: "196.00", you_owe: "370.00", open_share_count: 2, last_activity_date: "2026-08-05",
    seen_handles: [{ key: "kiranrao@o", handle: "kiranrao@o", display_name: "Kiran@bank 123456", count: 3, last_date: "2026-08-04" }] });
  expect(view.people.find((p) => p.name === "No Activity")).toMatchObject({ owed_to_you: "0.00", you_owe: "0.00", last_activity_date: null, seen_handles: [] });
  const summary = buildOverview([], view.shares.map((s) => ({ txnDate: s.date, personName: s.person, outstandingPaise: Math.round(Number(s.left) * 100) })), view.owed.map((o) => ({ personName: o.person, outstandingPaise: Math.round(Number(o.left) * 100) })));
  expect(summary.people.find((p) => p.name === "Kiran")).toEqual({ name: "Kiran", owed_to_you: kiran.owed_to_you, you_owe: kiran.you_owe });
  expect(Schema.is(PeopleOutput)({ people: view.people })).toBe(true);
});

test("open balances are oldest first, include partials, exclude linked inflows and suggest close names", () => {
  const view = fixtureView();
  const response = getOpenBalances(view, " kIrAn "); const person = response.people[0];
  expect(person.lines.map((l) => l.date)).toEqual(["2026-04-20", "2026-05-01", "2026-07-31", "2026-08-05"]);
  expect(person.lines[0]).toMatchObject({ kind: "share", expected: "6.00", settled: "4.00", left: "2.00" });
  expect(person.unlinked_inflows).toEqual([{ txn_ref: view.transactions.find((t) => t.date === "2026-08-03")!.ref, date: "2026-08-03", amount: "100.00", handle: "kiranrao@o", via: "seen" }]);
  expect(getOpenBalances(view).people.map((p) => p.name)).toEqual(["Kiran", "Only Historical"]);
  expect(getOpenBalances(view, "No Activity").people[0].lines).toEqual([]);
  expect(() => getOpenBalances(view, "Ravi")).toThrow("Close names: Ravi Teja");
  expect(Schema.is(OpenBalancesOutput)(response)).toBe(true);
});

test("unlinked inflows are capped at 20 newest rows and use counterparty keys rather than display-name guesses", () => {
  const model = readFixture(); const template = model.transactions.find((t) => t.id === "private-in-unlinked")!;
  model.transactions.push(...Array.from({ length: 25 }, (_, i) => ({ ...template, id: `extra-${i}`, txnDate: `2026-09-${String(i + 1).padStart(2, "0")}` })));
  model.transactions.push({ ...template, id: "display-collision", counterpartyKey: "unseen@bank", txnDate: "2026-10-01" });
  const inflows = getOpenBalances(fixtureView(model), "Kiran").people[0].unlinked_inflows;
  expect(inflows).toHaveLength(20); expect(inflows[0].date).toBe("2026-09-25"); expect(inflows.at(-1)!.date).toBe("2026-09-06");
});

test("payees sort by count, filter case-insensitively, page and expose learned people without IDs", () => {
  const view = fixtureView(); const first = pagePayees(view, { limit: 1 });
  expect(first.payees[0]).toMatchObject({ key: "kiranrao@o", row_count: 5, paid_total: "0.00", received_total: "500.00", seen_person: ["Kiran"] });
  expect(first.next_cursor).toBeTruthy();
  const second = pagePayees(view, { limit: 1, cursor: first.next_cursor! });
  expect(second.payees[0].key).toBe("rooster@bank");
  expect(pagePayees(view, { cursor: second.next_cursor! }).next_cursor).toBeNull();
  expect(pagePayees(view, { query: "KIRAN@BANK" }).payees).toHaveLength(1);
  expect(() => pagePayees(view, { cursor: "bad" })).toThrow("cursor");
  expect(Schema.is(PayeesOutput)(first)).toBe(true);
  expect(JSON.stringify(first)).not.toContain("private-");
});

test("learned keys can include multiple handles and non-UPI keys, without guessing by similar names", () => {
  const model = readFixture();
  const txn = model.transactions.find((t) => t.id === "private-in-two")!;
  txn.counterpartyKey = "kiranrao-1"; txn.counterpartyKind = "other";
  const view = fixtureView(model);
  expect(view.people[0].seen_handles.map((h) => h.key)).toEqual(["kiranrao@o", "kiranrao-1"]);
  expect(view.people[0].seen_handles[1]).toMatchObject({ handle: null, count: 1 });
  const source = model.transactions.find((t) => t.id === "private-in-unlinked")!;
  source.counterpartyKey = "kiranrao-1"; source.counterpartyKind = "other";
  expect(getOpenBalances(fixtureView(model), "Kiran").people[0].unlinked_inflows[0].handle).toBeNull();
  model.linkedInflows = [source.id];
  expect(getOpenBalances(fixtureView(model), "Kiran").people[0].unlinked_inflows).toEqual([]);
});

test("fully settled and over-settled lines are clamped to zero and excluded from open balances", () => {
  const model = readFixture();
  model.settlements.push({ id: "excess", splitParticipantId: "private-old-share", owedExpenseId: null, inflowTransactionId: null, netEventId: null, amountPaise: 1000, method: "cash", createdDate: "2026-09-02" });
  const view = fixtureView(model);
  expect(view.shares[1].left).toBe("0.00"); expect(view.people[0].open_share_count).toBe(1);
  expect(getOpenBalances(view, "Kiran").people[0].lines.some((l) => l.ref === view.shares[1].ref)).toBe(false);
});
