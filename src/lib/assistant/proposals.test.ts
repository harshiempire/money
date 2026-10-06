import { describe, expect, test } from "bun:test";
import { netBalance, splitBalance } from "./card-math";
import { proposeCategory, proposeItemizedSplit, proposeNetSettle, proposeNote, proposeSplit } from "./proposals";
import type { BillItemIntent } from "./find-intent";
import type { NetLine, TxnCardData } from "./types";

const card = (over: Partial<TxnCardData> = {}): TxnCardData => ({
  id: "t8",
  txnDate: "2026-08-14",
  amountPaise: 76000,
  drCr: "debit",
  channel: "upi",
  label: "paytmqr1k9x@",
  purpose: "Paytm",
  note: null,
  categoryId: null,
  needsReview: false,
  split: null,
  netEventId: null,
  href: "/transactions?txn=t8",
  ...over,
});

describe("proposeSplit", () => {
  test("half each with Nitin (handoff flow 2)", () => {
    const p = proposeSplit(card(), { mode: "equal", participants: [{ name: "nitin", amountPaise: null }] }, ["Nitin"]);
    expect(p).toMatchObject({
      ok: true,
      draft: { op: "split", totalPaise: 76000, yourShare: "380.00", parts: [{ name: "Nitin", amt: "380.00", known: true }] },
    });
  });

  test("the user is never a participant", () => {
    const p = proposeSplit(
      card(),
      { mode: "equal", participants: [{ name: "Nitin", amountPaise: null }, { name: "me", amountPaise: null }] },
      ["Nitin"],
    );
    expect(p.ok && p.draft.op === "split" && p.draft.parts.length).toBe(1);
  });

  test("I paid for him", () => {
    const p = proposeSplit(card(), { mode: "paid_for_them", participants: [{ name: "Satvik", amountPaise: null }] }, []);
    expect(p).toMatchObject({
      ok: true,
      draft: { yourShare: "0.00", parts: [{ name: "Satvik", amt: "760.00", known: false }] },
    });
  });

  test("unknown person leaves a blank card to fill", () => {
    const p = proposeSplit(card(), { mode: "equal", participants: [] }, []);
    expect(p.ok && p.draft.op === "split" && p.draft.parts).toEqual([{ name: "", amt: "", known: false }]);
  });

  test("guards: credits and existing splits", () => {
    expect(proposeSplit(card({ drCr: "credit" }), { mode: "equal", participants: [] }, []).ok).toBe(false);
    const existing = card({ split: { participants: 1, settled: 0, pendingPaise: 500, yourSharePaise: 0 } });
    expect(proposeSplit(existing, { mode: "equal", participants: [] }, [])).toMatchObject({ ok: false });
  });
});

describe("proposeItemizedSplit", () => {
  const shared = (label: string, pricePaise: number, qty = 1): BillItemIntent => ({
    label,
    pricePaise,
    qty,
    everyone: true,
    you: false,
    names: [],
  });
  const etsi = card({ amountPaise: 224700 });
  const dishes = [shared("pizza", 64500), shared("pasta", 52500), shared("cake", 47500), shared("tax", 5350, 2)];
  const nitins: BillItemIntent = { label: "Nitin's item", pricePaise: 49500, qty: 1, everyone: false, you: false, names: ["nitin"] };

  test("the Etsi bill balances to the paisa", () => {
    const p = proposeItemizedSplit(etsi, { people: ["Nitin", "Sai Abhinav"], items: [...dishes, nitins] }, [
      "Nitin",
      "Sai Abhinav",
    ]);
    expect(p).toMatchObject({
      ok: true,
      draft: {
        yourShare: "584.00",
        parts: [
          { name: "Nitin", amt: "1079.00", known: true },
          { name: "Sai Abhinav", amt: "584.00", known: true },
        ],
        items: { itemsTotalPaise: 224700 },
      },
    });
    if (!p.ok || p.draft.op !== "split") return;
    expect(splitBalance(p.draft.totalPaise, p.draft.yourShare, p.draft.parts).ok).toBe(true);
    expect(p.draft.items?.lines.map((l) => l.sharedBy)).toEqual(["everyone", "everyone", "everyone", "everyone", ["Nitin"]]);
    expect(p.say).toContain("exactly");
  });

  test("a gap between items and payment is flagged, not hidden in a share", () => {
    const p = proposeItemizedSplit(etsi, { people: ["Nitin", "Sai Abhinav"], items: dishes }, ["Nitin", "Sai Abhinav"]);
    expect(p.ok).toBe(true);
    if (!p.ok || p.draft.op !== "split") return;
    expect(splitBalance(p.draft.totalPaise, p.draft.yourShare, p.draft.parts)).toMatchObject({ residualPaise: 49500, ok: false });
    expect(p.say).toContain("isn't assigned");
  });

  test("someone named only on an item still joins the split", () => {
    const p = proposeItemizedSplit(etsi, { people: [], items: [nitins, shared("rest", 175200)] }, ["Nitin"]);
    expect(p.ok && p.draft.op === "split" && p.draft.parts.map((x) => [x.name, x.amt])).toEqual([["Nitin", "1371.00"]]);
  });

  test("nobody else named", () => {
    expect(proposeItemizedSplit(etsi, { people: ["me"], items: dishes }, []).ok).toBe(false);
  });
});

test("proposeNote keeps the current note for comparison", () => {
  expect(proposeNote(card({ note: "old" }), "  Funnel Hill Creamery  ")).toMatchObject({
    ok: true,
    draft: { op: "note", currentNote: "old", note: "Funnel Hill Creamery" },
  });
});

describe("proposeCategory", () => {
  const cats = [
    { id: "c1", name: "Shopping", kind: "spend" },
    { id: "c2", name: "Food", kind: "spend" },
  ];
  test("matches by name", () => {
    expect(proposeCategory(card(), "shopping", cats)).toMatchObject({ ok: true, draft: { categoryId: "c1" } });
    expect(proposeCategory(card(), "shop", cats)).toMatchObject({ ok: true, draft: { categoryId: "c1" } });
  });
  test("refuses unknown categories and lists the real ones", () => {
    const p = proposeCategory(card(), "Gadgets", cats);
    expect(p).toMatchObject({ ok: false });
    expect(!p.ok && p.reason).toContain("Shopping, Food");
  });
});

describe("proposeNetSettle", () => {
  const line = (id: string, outstandingPaise: number): NetLine => ({
    id,
    person: "Nitin",
    date: "2026-08-03",
    desc: id,
    outstandingPaise,
    val: "",
  });
  const credit = card({ id: "t0", drCr: "credit", amountPaise: 112000, txnDate: "2026-08-30" });

  test("prefills a balanced card (handoff flow 5)", () => {
    const p = proposeNetSettle(credit, "Nitin", {
      recv: [line("uber", 124000), line("toit", 38000)],
      pay: [line("movie", 50000)],
    });
    expect(p.ok).toBe(true);
    if (!p.ok || p.draft.op !== "net") return;
    expect(p.draft.recv.map((l) => l.val)).toEqual(["1240.00", "380.00"]);
    expect(p.draft.pay.map((l) => l.val)).toEqual(["500.00"]);
    expect(netBalance(p.draft.inflowPaise, p.draft.recv, p.draft.pay).ok).toBe(true);
  });

  test("guards", () => {
    expect(proposeNetSettle(card(), "Nitin", { recv: [line("a", 1)], pay: [] }).ok).toBe(false);
    expect(proposeNetSettle({ ...credit, netEventId: "ne" }, "Nitin", { recv: [line("a", 1)], pay: [] }).ok).toBe(false);
    expect(proposeNetSettle(credit, "Nitin", { recv: [], pay: [] }).ok).toBe(false);
  });
});
