import { expect, test } from "bun:test";
import { modelSafeText } from "./model-view";
import {
  assembleTagChunk,
  buildDraftRow,
  chunkSlice,
  defaultTagMonth,
  indexGuesses,
  parseTagRequest,
  readHistory,
  refForIndex,
  rowForModel,
  rowPreselected,
  selectUntagged,
  decideRememberDefault,
  proposeStandingNote,
  standingNoteModelWarning,
  standingNotesForModel,
  type TagFact,
} from "./tag-batch";

const categories = [
  { id: "food", name: "Food", kind: "spend" },
  { id: "travel", name: "Travel", kind: "spend" },
  { id: "dining", name: "Dining out", kind: "spend" },
  { id: "subs", name: "Subscriptions", kind: "spend" },
];

function fact(partial: Partial<TagFact> & Pick<TagFact, "id" | "txnDate">): TagFact {
  return {
    amountPaise: 10000,
    drCr: "debit",
    channel: "upi",
    categoryId: null,
    isTransfer: false,
    counterpartyId: null,
    displayName: null,
    parsedPurpose: null,
    label: "Payee",
    note: null,
    bankRefId: partial.id,
    defaultCategoryId: null,
    ...partial,
  };
}

test("selectUntagged keeps any month, drops categorized rows, and survives duplicate refs", () => {
  const rows = [
    fact({ id: "june-a", txnDate: "2026-06-02", label: "Swiggy", bankRefId: "REF1" }),
    fact({ id: "june-a", txnDate: "2026-06-02", label: "Swiggy duplicate id", bankRefId: "REF1" }),
    fact({ id: "june-reversal", txnDate: "2026-06-02", drCr: "credit", bankRefId: "REF1", label: "Swiggy reversal" }),
    fact({ id: "june-transfer", txnDate: "2026-06-18", isTransfer: true, label: "ATM", channel: "cash" }),
    fact({ id: "june-tagged-transfer", txnDate: "2026-06-19", isTransfer: true, categoryId: "travel" }),
    fact({ id: "june-tagged", txnDate: "2026-06-04", categoryId: "food" }),
    fact({ id: "july", txnDate: "2026-07-01" }),
    fact({ id: "no-party", txnDate: "2026-06-11", counterpartyId: null, parsedPurpose: null, label: "8125246237@ybl" }),
  ];

  const june = selectUntagged(rows, 2026, 6);
  expect(june.map((r) => r.id)).toEqual(["june-a", "june-reversal", "no-party", "june-transfer"]);
  expect(selectUntagged(rows, 2026, 7).map((r) => r.id)).toEqual(["july"]);
  expect(selectUntagged(rows, 2026, 8)).toEqual([]);
  expect(june.find((r) => r.id === "no-party")).toBeDefined();
});

test("chunks a month without dropping or overlapping rows", () => {
  const rows = Array.from({ length: 25 }, (_, i) => i);
  const first = chunkSlice(rows, 0, 12);
  const second = chunkSlice(rows, first.nextOffset ?? 0, 12);
  const third = chunkSlice(rows, second.nextOffset ?? 0, 12);
  expect(first.slice).toHaveLength(12);
  expect(second.slice).toHaveLength(12);
  expect(third.slice).toEqual([24]);
  expect(third.nextOffset).toBeNull();
  expect(refForIndex(12)).toBe("T13");
});

test("the tag entry point defaults to the latest untagged month and parses any month", () => {
  const months = [
    { year: 2026, month: 7, count: 40 },
    { year: 2026, month: 6, count: 22 },
  ];
  expect(defaultTagMonth(months)).toEqual(months[0]);
  expect(parseTagRequest("tag June", months, "2026-10-18")).toEqual({ year: 2026, month: 6 });
  expect(parseTagRequest("please categorize August 2025", months, "2026-10-18")).toEqual({ year: 2025, month: 8 });
  expect(parseTagRequest("tag all of March", [], "2026-10-18")).toEqual({ year: 2026, month: 3 });
  expect(parseTagRequest("categorize it", months, "2026-10-18")).toBeNull();
});

test("history and notes outrank a model guess, and a split history does not pick", () => {
  const swiggy = fact({
    id: "s",
    txnDate: "2026-06-02",
    counterpartyId: "cp-swiggy",
    displayName: "Swiggy",
    label: "swiggy@okaxis",
  });
  const pastFood = [
    fact({ id: "p1", txnDate: "2026-05-01", counterpartyId: "cp-swiggy", categoryId: "food", displayName: "Swiggy" }),
    fact({ id: "p2", txnDate: "2026-05-02", counterpartyId: "cp-swiggy", categoryId: "food", displayName: "Swiggy" }),
  ];
  const history = readHistory(swiggy, pastFood, categories);
  const row = buildDraftRow(
    swiggy,
    "T1",
    history,
    { ref: "T1", categoryName: "Travel", confidence: "high", reason: "model wanted travel" },
    categories,
  );
  expect(row.source).toBe("history");
  expect(row.suggestedCategoryId).toBe("food");
  expect(row.confidence).toBe("high");
  expect(rowPreselected(row)).toBe(true);

  const once = buildDraftRow(
    swiggy,
    "T1",
    readHistory(swiggy, [pastFood[0]], categories),
    undefined,
    categories,
  );
  expect(once.confidence).toBe("medium");
  expect(rowPreselected(once)).toBe(false);

  const split = fact({ id: "rahul", txnDate: "2026-06-11", counterpartyId: "cp-rahul", displayName: "Rahul S" });
  const conflict = buildDraftRow(
    split,
    "T2",
    readHistory(
      split,
      [
        fact({ id: "a", txnDate: "2026-04-01", counterpartyId: "cp-rahul", categoryId: "food", displayName: "Rahul S" }),
        fact({ id: "b", txnDate: "2026-04-02", counterpartyId: "cp-rahul", categoryId: "dining", displayName: "Rahul S" }),
      ],
      categories,
    ),
    { ref: "T2", categoryName: "Food", confidence: "high", reason: "guess" },
    categories,
  );
  expect(conflict.source).toBe("conflict");
  expect(conflict.suggestedCategoryId).toBeNull();
  expect(conflict.choices.map((c) => c.name).sort()).toEqual(["Dining out", "Food"]);
  expect(rowPreselected(conflict)).toBe(false);

  const noted = fact({ id: "netflix", txnDate: "2026-06-07", note: "Subscriptions renewal", label: "9876543210@ybl" });
  const fromNote = buildDraftRow(noted, "T3", readHistory(noted, [], categories), undefined, categories);
  expect(fromNote.source).toBe("note");
  expect(fromNote.suggestedCategoryId).toBe("subs");
  expect(rowPreselected(fromNote)).toBe(true);
});

test("a model-only guess is never pre-selected, and a low one asks for input", () => {
  const row = fact({ id: "atm", txnDate: "2026-06-18", channel: "cash", label: "ATM WDL", isTransfer: false });
  const highGuess = buildDraftRow(
    row,
    "T4",
    { kind: "none" },
    { ref: "T4", categoryName: "Food", confidence: "high", reason: "looks like food" },
    categories,
  );
  expect(highGuess.source).toBe("model");
  expect(rowPreselected(highGuess)).toBe(false);

  const low = buildDraftRow(
    row,
    "T5",
    { kind: "none" },
    { ref: "T5", categoryName: "Travel", confidence: "low", reason: "unsure" },
    categories,
  );
  expect(low.confidence).toBe("low");
  expect(rowPreselected(low)).toBe(false);

  const none = buildDraftRow(row, "T6", { kind: "none" }, { ref: "T6", categoryName: null, confidence: "none", reason: "" }, categories);
  expect(none.source).toBe("none");
  expect(none.suggestedCategoryId).toBeNull();
});

test("the model sees a safe payee and note, never a handle, a long number, or an id", () => {
  const row = fact({
    id: "secret-id",
    txnDate: "2026-06-02",
    counterpartyId: "cp-secret",
    displayName: null,
    parsedPurpose: null,
    label: "swiggy.stores@okaxis",
    note: "order 9988776655 for dinner",
    bankRefId: "UPIREF9988776655",
    amountPaise: 41200,
  });
  const view = rowForModel(row, "T1");
  expect(view.payee).toBe("Payee");
  expect(view.note).toBeNull();
  expect(view.ref).toBe("T1");
  expect(JSON.stringify(view)).not.toContain("secret");
  expect(JSON.stringify(view)).not.toContain("99887");
  expect(JSON.stringify(view)).not.toContain("@");

  const safeNote = fact({ ...row, id: "n", note: "team lunch", displayName: "Swiggy", label: "swiggy@okaxis" });
  const shown = rowForModel(safeNote, "T2");
  expect(shown.payee).toBe("Swiggy");
  expect(shown.note).toBe("team lunch");
  expect(shown.amount).toBe("₹412.00");
});

test("duplicate model refs collapse and unknown refs are ignored", () => {
  const known = new Set(["T1", "T2"]);
  const indexed = indexGuesses(
    [
      { ref: "t1", categoryName: "Food", confidence: "low", reason: "first" },
      { ref: "T1", categoryName: "Travel", confidence: "high", reason: "second" },
      { ref: "T9", categoryName: "Food", confidence: "high", reason: "nope" },
    ],
    known,
  );
  expect(indexed.size).toBe(1);
  expect(indexed.get("T1")?.categoryName).toBe("Food");
});

test("standing notes and free text drop handles and long numbers", () => {
  expect(modelSafeText("Swiggy and Zomato are Food")).toBe("Swiggy and Zomato are Food");
  expect(modelSafeText("rahul@oksbi")).toBeNull();
  expect(modelSafeText("call 9988776655")).toBeNull();
  expect(modelSafeText("UPIREF12345 paid")).toBeNull();
  expect(standingNotesForModel(["Swiggy is Food", "me@upi", "account 1234567890"])).toEqual(["Swiggy is Food"]);
  expect(proposeStandingNote("Swiggy is Food")).toEqual({ ok: true, body: "Swiggy is Food" });
  expect(proposeStandingNote("rahul@oksbi").ok).toBe(false);
  expect(standingNoteModelWarning("Swiggy is Food")).toBeNull();
  expect(standingNoteModelWarning("rahul@oksbi")).toMatch(/skip this note/);
  expect(standingNoteModelWarning("account 1234567890")).toMatch(/skip this note/);
});

test("a generic payee label does not borrow another payment's category", () => {
  const past = [
    fact({ id: "p1", txnDate: "2026-05-01", label: "payee", categoryId: "food" }),
    fact({ id: "p2", txnDate: "2026-05-02", label: "PAYEE", categoryId: "food" }),
    fact({ id: "s1", txnDate: "2026-05-03", label: "Self", displayName: "Self", categoryId: "travel" }),
    fact({ id: "s2", txnDate: "2026-05-04", label: "Self", displayName: "Self", categoryId: "travel" }),
    fact({ id: "c1", txnDate: "2026-05-05", label: "Cafe", displayName: "Cafe", categoryId: "food" }),
    fact({ id: "c2", txnDate: "2026-05-06", label: "Cafe", displayName: "Cafe", categoryId: "food" }),
  ];
  expect(readHistory(fact({ id: "t", txnDate: "2026-06-01", label: "Payee" }), past, categories).kind).toBe("none");
  expect(readHistory(fact({ id: "t2", txnDate: "2026-06-02", label: "Self", displayName: "Self" }), past, categories).kind).toBe("none");
  const cafe = readHistory(fact({ id: "t3", txnDate: "2026-06-03", label: "Cafe", displayName: "Cafe" }), past, categories);
  expect(cafe.kind).toBe("match");
  if (cafe.kind === "match") expect(cafe.categoryId).toBe("food");
});

test("remembering a default does not replace a different one without naming it", () => {
  expect(decideRememberDefault({ currentCategoryId: null, nextCategoryId: "food" })).toEqual({ action: "set" });
  expect(decideRememberDefault({ currentCategoryId: "food", nextCategoryId: "food" })).toEqual({ action: "unchanged" });
  expect(decideRememberDefault({ currentCategoryId: "groceries", nextCategoryId: "food" })).toEqual({
    action: "confirm",
    existingCategoryId: "groceries",
  });
  expect(
    decideRememberDefault({ currentCategoryId: "groceries", nextCategoryId: "food", confirmFromCategoryId: "groceries" }),
  ).toEqual({ action: "set" });
  expect(
    decideRememberDefault({ currentCategoryId: "groceries", nextCategoryId: "food", confirmFromCategoryId: "travel" }),
  ).toEqual({ action: "confirm", existingCategoryId: "groceries" });
});

test("a chunk draft keeps history and conflict rows away from the model", () => {
  const past = [
    fact({ id: "p1", txnDate: "2026-05-01", counterpartyId: "swiggy", categoryId: "food", displayName: "Swiggy" }),
    fact({ id: "p2", txnDate: "2026-05-02", counterpartyId: "swiggy", categoryId: "food", displayName: "Swiggy" }),
    fact({ id: "p3", txnDate: "2026-05-03", counterpartyId: "cafe", categoryId: "food", displayName: "Cafe" }),
    fact({ id: "p4", txnDate: "2026-05-04", counterpartyId: "cafe", categoryId: "travel", displayName: "Cafe" }),
  ];
  const untagged = [
    fact({ id: "a", txnDate: "2026-06-02", counterpartyId: "swiggy", displayName: "Swiggy" }),
    fact({ id: "b", txnDate: "2026-06-03", counterpartyId: "cafe", displayName: "Cafe" }),
    fact({ id: "c", txnDate: "2026-06-04", displayName: "Unknown shop", label: "Unknown shop" }),
    fact({ id: "d", txnDate: "2026-07-01", displayName: "July" }),
  ];
  const open = assembleTagChunk({ untagged, past, categories, year: 2026, month: 6, offset: 0 });
  expect(open.total).toBe(3);
  expect(open.needsModel.map((row) => row.ref)).toEqual(["T3"]);
  expect(open.rows[0]?.source).toBe("history");
  expect(open.rows[0]?.suggestedCategoryId).toBe("food");
  expect(rowPreselected(open.rows[0]!)).toBe(true);
  expect(open.rows[1]?.source).toBe("conflict");
  expect(open.rows[1]?.suggestedCategoryId).toBeNull();

  const filled = assembleTagChunk({
    untagged,
    past,
    categories,
    year: 2026,
    month: 6,
    offset: 0,
    guesses: [
      { ref: "T1", categoryName: "Travel", confidence: "high", reason: "ignore history" },
      { ref: "T2", categoryName: "Food", confidence: "high", reason: "ignore conflict" },
      { ref: "T3", categoryName: "Travel", confidence: "high", reason: "guess" },
    ],
  });
  expect(filled.rows[0]?.source).toBe("history");
  expect(filled.rows[0]?.suggestedCategoryId).toBe("food");
  expect(filled.rows[1]?.source).toBe("conflict");
  expect(filled.rows[1]?.suggestedCategoryId).toBeNull();
  expect(filled.rows[2]?.source).toBe("model");
  expect(filled.rows[2]?.suggestedCategoryId).toBe("travel");
  expect(rowPreselected(filled.rows[2]!)).toBe(false);
  expect(filled.needsModel.map((row) => row.ref)).toEqual(["T3"]);
});
