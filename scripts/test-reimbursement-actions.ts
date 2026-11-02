/**
 * Integration check for cash settlements, write-offs and owed expenses
 * against the Neon `local-dev` branch ONLY. Never production.
 *
 * Throwaway user with a split (Asha ₹300, Bala ₹300; ₹100 of Bala's already
 * settled from a bank credit), a category, and a second user's category.
 * Runs the handlers through runAction(), checks results and rows, then
 * deletes both users (everything cascades). Expected outcomes match the
 * pre-Effect implementation (verified side by side on 2026-11-02).
 *
 *   DATABASE_URL="$(cat ~/.money-scratch/local-dev/dburl)" \
 *     bun run --conditions=react-server --preload="$HOME/.money-scratch/neon-dns.cjs" \
 *     scripts/test-reimbursement-actions.ts
 */
export {};

const { requireLocalDevDatabase } = await import("./lib/local-dev-guard");
requireLocalDevDatabase();

const { asc, eq, inArray } = await import("drizzle-orm");
const { Layer } = await import("effect");
const { db, schema } = await import("../src/db");
const { runAction } = await import("../src/lib/action/core");
const { CurrentUser, Db } = await import("../src/lib/action/services");
const R = await import("../src/app/reimbursements/reimbursement-handlers");
const O = await import("../src/app/reimbursements/owed-expense-handlers");

type Result = { ok: boolean; code?: string; message?: string; data?: unknown };
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
const call = (spec: any, input: unknown) => runAction(spec, input, { name: "test", layer, log: () => {} }) as Promise<Result>;

try {
  await db.insert(schema.users).values([{ id: userId, email: `reimb-test+${userId}@example.invalid` }, { id: otherId, email: `reimb-test-other+${otherId}@example.invalid` }]);
  const [acct] = await db.insert(schema.moneyAccounts).values({ userId, name: "T", bank: "bob", openingBalancePaise: 0, openingDate: "2026-01-01" }).returning();
  const base = { accountId: acct.id, txnDate: "2026-10-01", channel: "upi" as const, rawDescription: "t" };
  const [debit] = await db.insert(schema.transactions).values({ ...base, amountPaise: 100000, drCr: "debit", refId: "D" }).returning();
  const [credit] = await db.insert(schema.transactions).values({ ...base, amountPaise: 10000, drCr: "credit", refId: "C" }).returning();
  const [split] = await db.insert(schema.splits).values({ transactionId: debit.id, totalPaise: 100000, yourSharePaise: 40000 }).returning();
  const [asha] = await db.insert(schema.splitParticipants).values({ splitId: split.id, personName: "Asha", expectedAmountPaise: 30000 }).returning();
  const [bala] = await db.insert(schema.splitParticipants).values({ splitId: split.id, personName: "Bala", expectedAmountPaise: 30000 }).returning();
  await db.insert(schema.settlements).values({ splitParticipantId: bala.id, inflowTransactionId: credit.id, amountPaise: 10000, method: "bank" });
  const [cat] = await db.insert(schema.categories).values({ userId, name: "Food", kind: "spend" }).returning();
  const [otherCat] = await db.insert(schema.categories).values({ userId: otherId, name: "Theirs", kind: "spend" }).returning();
  const rows = (p: string) => db.select().from(schema.settlements).where(eq(schema.settlements.splitParticipantId, p)).orderBy(asc(schema.settlements.createdAt));
  const sum = async (p: string, method: string) => (await rows(p)).filter((s) => s.method === method).reduce((t, s) => t + s.amountPaise, 0);

  console.log("cash settlements");
  let r = await call(R.recordCashSettlementSpec, { splitParticipantId: asha.id, amountPaise: 10000, note: "  paid half  " });
  expect("cash ₹100 for Asha → ok, note trimmed", r.ok && (await rows(asha.id))[0]?.note === "paid half", r);
  r = await call(R.recordCashSettlementSpec, { splitParticipantId: asha.id, amountPaise: 50000, note: null });
  expect("cash ₹500 → capped at the ₹200 outstanding", r.ok && (await sum(asha.id, "cash")) === 30000, await sum(asha.id, "cash"));
  r = await call(R.recordCashSettlementSpec, { splitParticipantId: asha.id, amountPaise: 5000, note: null });
  expect("nothing outstanding → silent no-op", r.ok && (await rows(asha.id)).length === 2, r);
  r = await call(R.recordCashSettlementSpec, { splitParticipantId: crypto.randomUUID(), amountPaise: 100, note: null });
  expect("unknown participant → FORBIDDEN", r.code === "FORBIDDEN", r);

  console.log("write-offs");
  r = await call(R.writeOffParticipantShareSpec, { splitParticipantId: asha.id, note: null });
  expect("forgive fully-paid Asha → CONFLICT 'Nothing outstanding…'", r.code === "CONFLICT" && r.message === "Nothing outstanding on this share to forgive.", r);
  r = await call(R.writeOffParticipantShareSpec, { splitParticipantId: bala.id, note: " moved away " });
  expect("forgive Bala → writes off the ₹200 left", r.ok && (await sum(bala.id, "writeoff")) === 20000, r);
  const writeoffId = (await rows(bala.id)).find((s) => s.method === "writeoff")!.id;
  const cashId = (await rows(asha.id)).find((s) => s.method === "cash")!.id;
  r = await call(R.deleteCashSettlementSpec, { settlementId: writeoffId });
  expect("delete-cash on a writeoff deletes nothing", r.ok && (await sum(bala.id, "writeoff")) === 20000, r);
  r = await call(R.undoWriteOffSpec, { settlementId: cashId });
  expect("undo-writeoff on a cash row → INVALID, row kept", r.code === "INVALID" && r.message === "This settlement is not a writeoff and cannot be undone here." && (await sum(asha.id, "cash")) === 30000, r);
  r = await call(R.undoWriteOffSpec, { settlementId: writeoffId });
  expect("undo Bala's writeoff → ok, gone", r.ok && (await sum(bala.id, "writeoff")) === 0, r);
  r = await call(R.deleteCashSettlementSpec, { settlementId: cashId });
  expect("delete Asha's first cash row → ok", r.ok && (await sum(asha.id, "cash")) === 20000, r);

  console.log("owed expenses");
  r = await call(O.createOwedExpenseSpec, { personName: "Dev", incurredDate: "2026-10-02", amountPaise: 0, description: "x" });
  expect("amount 0 → 'Amount must be positive'", r.message === "Amount must be positive", r);
  r = await call(O.createOwedExpenseSpec, { personName: "  ", incurredDate: "2026-10-02", amountPaise: 100, description: "x" });
  expect("blank person name → INVALID 'Person name must not be empty'", r.code === "INVALID" && r.message === "Person name must not be empty", r);
  r = await call(O.createOwedExpenseSpec, { personName: "Dev", incurredDate: "2026-10-02", amountPaise: 100, description: "x", categoryId: otherCat.id });
  expect("another user's category → FORBIDDEN", r.code === "FORBIDDEN", r);
  r = await call(O.createOwedExpenseSpec, { personName: " Dev ", incurredDate: "2026-10-02", amountPaise: 12345.6, description: " tickets ", categoryId: cat.id, note: "n".repeat(250) });
  const [owed] = await db.select().from(schema.owedExpenses).where(eq(schema.owedExpenses.userId, userId));
  expect("valid create → ok with the new id", r.ok && r.data === owed?.id, r);
  expect("…trimmed, rounded to 12346, note cut to 200", owed?.personName === "Dev" && owed.description === "tickets" && owed.amountPaise === 12346 && owed.note?.length === 200 && owed.categoryId === cat.id, owed);
  r = await call(O.updateOwedExpenseSpec, { id: owed.id, amountPaise: 999, description: " new ", categoryId: null, note: "" });
  const [updated] = await db.select().from(schema.owedExpenses).where(eq(schema.owedExpenses.id, owed.id));
  expect("update → ok; category cleared, note null", r.ok && updated.amountPaise === 999 && updated.description === "new" && updated.categoryId === null && updated.note === null, updated);
  r = await call(O.updateOwedExpenseSpec, { id: owed.id, categoryId: otherCat.id });
  expect("update to another user's category → FORBIDDEN", r.code === "FORBIDDEN", r);
  r = await call(O.deleteOwedExpenseSpec, { id: owed.id });
  expect("delete → ok, gone", r.ok && (await db.select().from(schema.owedExpenses).where(eq(schema.owedExpenses.id, owed.id))).length === 0, r);
} finally {
  await db.delete(schema.users).where(inArray(schema.users.id, [userId, otherId]));
  const left = await db.select().from(schema.users).where(inArray(schema.users.id, [userId, otherId]));
  console.log(`\ncleanup: test users ${left.length ? "STILL PRESENT" : "deleted (cascade)"}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  process.exit(failures.length === 0 ? 0 : 1);
}
