/**
 * Integration check for the per-transaction actions (category, apply to all,
 * transfer, review, notes, auto-detect) against the Neon `local-dev` branch
 * ONLY. Never production.
 *
 * Throwaway user (plus a second user for ownership checks) with categories,
 * counterparties and transactions; runs the handlers through runAction(),
 * checks results and rows, then removes everything. Expected outcomes match
 * the pre-Effect implementation (verified side by side on 2026-11-02).
 *
 *   DATABASE_URL="$(cat ~/.money-scratch/local-dev/dburl)" \
 *     bun run --conditions=react-server --preload="$HOME/.money-scratch/neon-dns.cjs" \
 *     scripts/test-transaction-actions.ts
 */
export {};

const { requireLocalDevDatabase } = await import("./lib/local-dev-guard");
requireLocalDevDatabase();

const { eq, inArray } = await import("drizzle-orm");
const { Layer } = await import("effect");
const { db, schema } = await import("../src/db");
const { runAction } = await import("../src/lib/action/core");
const { CurrentUser, Db } = await import("../src/lib/action/services");
const H = await import("../src/app/transactions/transaction-handlers");
const RD = await import("../src/app/transactions/transaction-read-handlers");

type Result = { ok: boolean; code?: string; message?: string; data?: any };
const userId = crypto.randomUUID();
const otherId = crypto.randomUUID();
const failures: string[] = [];
let passed = 0;
function expect(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const layer = Layer.merge(Layer.succeed(CurrentUser, { id: userId, email: null }), Layer.succeed(Db, db));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (spec: any, input?: unknown) => runAction(spec, input, { name: "test", layer, log: () => {} }) as Promise<Result>;

try {
  await db.insert(schema.users).values([{ id: userId, email: `txn-test+${userId}@example.invalid` }, { id: otherId, email: `txn-test-o+${otherId}@example.invalid` }]);
  const [acct] = await db.insert(schema.moneyAccounts).values({ userId, name: "T", bank: "bob", openingBalancePaise: 0, openingDate: "2026-01-01" }).returning();
  const [oacct] = await db.insert(schema.moneyAccounts).values({ userId: otherId, name: "O", bank: "bob", openingBalancePaise: 0, openingDate: "2026-01-01" }).returning();
  const [swiggy] = await db.insert(schema.counterparties).values({ userId, kind: "merchant", key: "SWIGGY" }).returning();
  const cat = async (u: string, name: string, kind: "spend" | "transfer" | "investment") => (await db.insert(schema.categories).values({ userId: u, name, kind }).returning())[0].id;
  const food = await cat(userId, "Food", "spend"), xfer = await cat(userId, "Transfer", "transfer"), theirs = await cat(otherId, "Theirs", "spend");
  const txn = async (accountId: string, refId: string, amt: number, drCr: "debit" | "credit", date: string, cp: string | null, channel: "upi" | "imps" = "upi") =>
    (await db.insert(schema.transactions).values({ accountId, refId, amountPaise: amt, drCr, txnDate: date, counterpartyId: cp, channel, rawDescription: refId }).returning())[0].id;
  const t1 = await txn(acct.id, "T1", 50000, "debit", "2026-10-01", swiggy.id);
  const t2 = await txn(acct.id, "T2", 20000, "debit", "2026-10-02", swiggy.id);
  const t3 = await txn(acct.id, "T3", 30000, "debit", "2026-10-03", swiggy.id);
  await txn(acct.id, "PD", 77700, "debit", "2026-10-10", null, "imps");
  await txn(acct.id, "PC", 77700, "credit", "2026-10-12", null, "imps");
  const foreign = await txn(oacct.id, "F", 100, "debit", "2026-10-01", null);
  const get = async (id: string) => (await db.select().from(schema.transactions).where(eq(schema.transactions.id, id)))[0];

  console.log("category");
  let r = await call(H.setTransactionCategorySpec, { transactionId: t1, categoryId: xfer });
  let row = await get(t1);
  expect("Transfer category → ok, marks it a transfer", r.ok && row.categoryId === xfer && row.isTransfer, row);
  r = await call(H.setTransactionCategorySpec, { transactionId: t1, categoryId: "" });
  row = await get(t1);
  expect("'' clears category and transfer flag", r.ok && row.categoryId === null && !row.isTransfer, row);
  r = await call(H.setTransactionCategorySpec, { transactionId: t1, categoryId: food, expectedCurrentCategoryId: xfer });
  expect("stale card (category changed since) → CONFLICT, untouched", r.code === "CONFLICT" && r.message === "The category changed since this card was made. Ask again to get a fresh card." && (await get(t1)).categoryId === null, r);
  r = await call(H.setTransactionCategorySpec, { transactionId: t1, categoryId: food, isTransfer: true });
  row = await get(t1);
  expect("a client-supplied isTransfer is ignored (Food → not a transfer)", r.ok && row.categoryId === food && !row.isTransfer, row);
  await call(H.setTransactionCategorySpec, { transactionId: t1, categoryId: "" });
  r = await call(H.setTransactionCategorySpec, { transactionId: t1, categoryId: theirs });
  expect("another user's category → FORBIDDEN", r.code === "FORBIDDEN", r);
  r = await call(H.setTransactionCategorySpec, { transactionId: foreign, categoryId: food });
  expect("another user's transaction → FORBIDDEN, untouched", r.code === "FORBIDDEN" && (await get(foreign)).categoryId === null, r);

  console.log("apply to all");
  r = await call(H.applyCategoryToCounterpartySpec, { transactionId: t2 });
  expect("from an uncategorised row → { updated: 0 }", r.ok && r.data?.updated === 0, r);
  await call(H.setTransactionCategorySpec, { transactionId: t1, categoryId: food });
  r = await call(H.applyCategoryToCounterpartySpec, { transactionId: t1 });
  const [cp] = await db.select().from(schema.counterparties).where(eq(schema.counterparties.id, swiggy.id));
  expect("from T1 → { updated: 2, ids: [T2, T3] }, both siblings now Food", r.ok && r.data?.updated === 2 && JSON.stringify([...r.data.ids].sort()) === JSON.stringify([t2, t3].sort()) && (await get(t2)).categoryId === food && (await get(t3)).categoryId === food, r);
  expect("…and SWIGGY's default category is Food", cp.defaultCategoryId === food, cp);

  console.log("flags and notes");
  r = await call(H.setTransactionTransferSpec, { transactionId: t2, isTransfer: true });
  expect("transfer flag on", r.ok && (await get(t2)).isTransfer, r);
  r = await call(H.setTransactionNeedsReviewSpec, { transactionId: t2, needsReview: true });
  expect("review flag on", r.ok && (await get(t2)).needsReview, r);
  r = await call(H.setTransactionNoteSpec, { transactionId: t2, note: "  hi  " });
  expect("note trimmed", r.ok && (await get(t2)).note === "hi", r);
  r = await call(H.setTransactionNoteSpec, { transactionId: t2, note: "x", expectedCurrentNote: "something else" });
  expect("stale note card → CONFLICT, note kept", r.code === "CONFLICT" && r.message === "The note changed since this card was made. Ask again to get a fresh card." && (await get(t2)).note === "hi", r);
  r = await call(H.setTransactionNoteSpec, { transactionId: t2, note: "   " });
  expect("blank note → null", r.ok && (await get(t2)).note === null, r);
  r = await call(H.applyNoteToTransactionsSpec, { transactionIds: [t2, t3], note: " bulk " });
  expect("bulk note → { updated: 2 }", r.ok && r.data?.updated === 2 && (await get(t3)).note === "bulk", r);
  r = await call(H.applyNoteToTransactionsSpec, { transactionIds: [t3, foreign], note: "evil" });
  expect("bulk note including a foreign id → FORBIDDEN, nothing changed", r.code === "FORBIDDEN" && (await get(t3)).note === "bulk" && (await get(foreign)).note === null, r);

  console.log("reads");
  r = await call(RD.getNoteCandidatesSpec, { transactionId: t1 });
  expect("note candidates for T1 → T3, T2 (newest first, T1 excluded)", r.ok && JSON.stringify(r.data.map((c: { id: string }) => c.id)) === JSON.stringify([t3, t2]), r.data);
  const [split] = await db.insert(schema.splits).values({ transactionId: t1, totalPaise: 50000, yourSharePaise: 20000 }).returning();
  const [asha] = await db.insert(schema.splitParticipants).values({ splitId: split.id, personName: "Asha", expectedAmountPaise: 30000 }).returning();
  await db.insert(schema.settlements).values({ splitParticipantId: asha.id, amountPaise: 10000, method: "cash" });
  r = await call(RD.getLinkedTransactionPreviewSpec, { transactionId: t1 });
  expect("preview: split ₹300 expected, ₹100 settled, ₹200 outstanding", r.ok && r.data.split?.expectedReimbursePaise === 30000 && r.data.split.settledReimbursePaise === 10000 && r.data.split.outstandingReimbursePaise === 20000 && r.data.split.status === "partial", r.data?.split);
  r = await call(RD.getLinkedTransactionPreviewSpec, { transactionId: foreign });
  expect("preview of another user's transaction → FORBIDDEN", r.code === "FORBIDDEN", r);

  console.log("auto-detect");
  r = await call(H.autoDetectTransfersSpec);
  expect("finds the ₹777 IMPS pair → { pairs: 1 }", r.ok && r.data?.pairs === 1, r);
  r = await call(H.autoDetectTransfersSpec);
  expect("second run → { pairs: 0 }", r.ok && r.data?.pairs === 0, r);
} finally {
  // transaction.category_id and counterparty.default_category_id don't cascade.
  const accts = await db.select().from(schema.moneyAccounts).where(inArray(schema.moneyAccounts.userId, [userId, otherId]));
  if (accts.length) await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, accts.map((a) => a.id)));
  await db.delete(schema.counterparties).where(inArray(schema.counterparties.userId, [userId, otherId]));
  await db.delete(schema.users).where(inArray(schema.users.id, [userId, otherId]));
  const left = await db.select().from(schema.users).where(inArray(schema.users.id, [userId, otherId]));
  console.log(`\ncleanup: test users ${left.length ? "STILL PRESENT" : "deleted"}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  process.exit(failures.length === 0 ? 0 : 1);
}
