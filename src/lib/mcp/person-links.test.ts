import { expect, test } from "bun:test";
import { Schema } from "effect";
import { suggestPersonPayees, handleStem } from "./person-links";
import { RelationalInputs } from "./relational-schemas";
import { fixtureView, readFixture, fixtureTxn } from "./read-fixtures";
import { getOpenBalances } from "./model-view";
import { findPayments } from "./find-payments";
import { buildMcpQueryTables } from "./query-tables";

test("link suggestions use settlement counts, stems and long name tokens, never short names or confirmed payees", () => {
  expect(handleStem(" kiranrao-1@okaxi ")).toBe("kiranrao");
  const payees = ["kiranrao-1", "kiranrao@o", "kiranrao-1@okaxi", "kiran-other@bank", "other@bank"].map(key => ({ key, person: null as string | null }));
  payees.push({ key: "kiranrao@oksbi", person: "Kiran" }, { key: "kiranrao-2", person: "Other" });
  const rows = suggestPersonPayees("Kiran", payees, [{ key: "kiranrao@o", count: 2 }]);
  expect(rows).toContainEqual({ key: "kiranrao@o", reason: "settled this person's shares 2 times" });
  expect(rows.find(r => r.key === "kiranrao-1")?.reason).toBe("handle looks like this person's other handles");
  expect(rows.map(r => r.key)).toContain("kiran-other@bank");
  expect(rows.map(r => r.key)).not.toContain("kiranrao-2");
  expect(rows.map(r => r.key)).not.toContain("other@bank");
  expect(suggestPersonPayees("Al Li", [{ key: "alice@bank" }, { key: "li@other" }], [])).toEqual([]);
  expect(suggestPersonPayees("Al", [{ key: "al-1@bank" }], [{ key: "al@other", count: 1 }])).toEqual([]);
});

test("link_person schema requires guards, exactly one selector, 1–50 links and a valid key", () => {
  const input = { links: [{ payee: "kiranrao-1", person: "Kiran", current_person: null }], idempotency_key: "link-key-123" };
  const is = Schema.is(RelationalInputs.link_person);
  expect(is(input)).toBe(true);
  expect(is({ ...input, links: [{ ref: "txn_1", person: null, current_person: "Kiran" }] })).toBe(true);
  for (const links of [[], Array(51).fill(input.links[0]), [{ payee: "key", person: "Kiran" }], [{ ...input.links[0], ref: "txn_1" }], [{ person: "Kiran", current_person: null }], [{ ...input.links[0], person: " " }]])
    expect(is({ ...input, links })).toBe(false);
  expect(is({ ...input, idempotency_key: "short" })).toBe(false);
});

test("confirmed person projects into transactions, payees, candidates and SQL; suggestions stay out of balances", () => {
  const model = readFixture();
  model.payees.push({ key: "kiranrao-1", kind: "other", displayName: null, defaultCategory: null, isSelf: false, isFamily: false });
  model.transactions.push(fixtureTxn("private-wrapped", { txnDate: "2026-08-03", amountPaise: 5500, drCr: "credit", counterpartyKey: "kiranrao-1", counterpartyKind: "other" }));
  const before = fixtureView(model);
  expect(before.people[0].suggested_payees.map(p => p.key)).toContain("kiranrao-1");
  expect(getOpenBalances(before, "Kiran").people[0].unlinked_inflows.some(t => t.amount === "55.00")).toBe(false);
  model.payees.at(-1)!.person = "Kiran";
  const view = fixtureView(model), wrapped = view.transactions.at(-1)!;
  expect(wrapped.person).toBe("Kiran");
  expect(view.payees.find(p => p.key === "kiranrao-1")).toMatchObject({ person: "Kiran", seen_person: [] });
  expect(view.people[0].linked_payees.map(p => p.key)).toEqual(["kiranrao-1"]);
  expect(view.people[0].suggested_payees.map(p => p.key)).not.toContain("kiranrao-1");
  expect(getOpenBalances(view, "Kiran").people[0].unlinked_inflows).toContainEqual({ txn_ref: wrapped.ref, date: "2026-08-03", amount: "55.00", handle: null, via: "linked" });
  expect(findPayments(view, { person: "Kiran", amount: "55" }).candidates[0]).toMatchObject({ ref: wrapped.ref, person: "Kiran", via: "linked" });
  const tables = buildMcpQueryTables(view, [], []);
  for (const name of ["transactions", "payees"]) {
    const table = tables.find(t => t.name === name)!;
    const row = table.rows.find(r => r[0] === (name === "transactions" ? wrapped.ref : "kiranrao-1"))!;
    expect(row[table.columns.findIndex(c => c.name === "person")]).toBe("Kiran");
    expect(row[table.columns.findIndex(c => c.name === "via")]).toBe("linked");
  }
  const table = tables.find(t => t.name === "payees")!;
  expect(table.rows.find(r => r[0] === "kiranrao@o")![table.columns.findIndex(c => c.name === "via")]).toBe("seen");
});
