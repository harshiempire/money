/**
 * Integration check for the Net Settle actions against the Neon `local-dev`
 * branch ONLY. Never production.
 *
 * Throwaway user with a ₹1,000 split (Asha ₹300, Bala ₹300), a ₹600 credit,
 * a ₹250 payable to Dev and a category; runs saveNetEvent / deleteNetEvent
 * through runAction() (decode → handler → ActionResult), checks results and
 * rows, then deletes the user (everything cascades). Expected outcomes match
 * the pre-Effect implementation (verified side by side on 2026-11-02).
 *
 *   DATABASE_URL="$(cat ~/.money-scratch/local-dev/dburl)" \
 *     bun run --conditions=react-server --preload="$HOME/.money-scratch/neon-dns.cjs" \
 *     scripts/test-net-event-actions.ts
 */
// Type-only (erased at runtime), so nothing loads before the URL guard below.
import type { Layer as LayerType } from "effect";

const LOCAL_DEV_ENDPOINT = "<local-dev-endpoint>";
if (!process.env.DATABASE_URL?.includes(LOCAL_DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the local-dev branch (${LOCAL_DEV_ENDPOINT}).`);
  process.exit(2);
}

const { asc, eq, inArray } = await import("drizzle-orm");
const { Layer } = await import("effect");
const { db, schema } = await import("../src/db");
const { runAction } = await import("../src/lib/action/core");
const { CurrentUser, Db } = await import("../src/lib/action/services");
const { saveNetEventSpec, deleteNetEventSpec } = await import("../src/app/transactions/net-event-handlers");

type Result = { ok: boolean; code?: string; message?: string };
const userId = crypto.randomUUID();
const failures: string[] = [];
let passed = 0;
function expect(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

const layerFor = (database: unknown) =>
  Layer.merge(Layer.succeed(CurrentUser, { id: userId, email: null }), Layer.succeed(Db, database as typeof db));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (spec: any, input: unknown, layer: LayerType.Layer<any, any> = layerFor(db)) =>
  runAction(spec, input, { name: "test", layer, log: () => {} }) as Promise<Result>;
const save = (input: unknown) => call(saveNetEventSpec, input);

const R = (id: string, amt: number, method: "bank" | "offset") => ({ kind: "receivable", splitParticipantId: id, amountPaise: amt, method });
const P = (owedExpenseId: string, amt: number, method = "offset") => ({ kind: "payable", owedExpenseId, amountPaise: amt, method });
const d = "2026-10-05";

try {
  await db.insert(schema.users).values({ id: userId, email: `net-actions-test+${userId}@example.invalid` });
  const [acct] = await db.insert(schema.moneyAccounts).values({ userId, name: "T", bank: "bob", openingBalancePaise: 0, openingDate: "2026-01-01" }).returning();
  const base = { accountId: acct.id, txnDate: "2026-10-01", channel: "upi" as const, rawDescription: "t" };
  const [debit] = await db.insert(schema.transactions).values({ ...base, amountPaise: 100000, drCr: "debit", refId: "D" }).returning();
  const [inflow] = await db.insert(schema.transactions).values({ ...base, amountPaise: 60000, drCr: "credit", refId: "IN" }).returning();
  const [split] = await db.insert(schema.splits).values({ transactionId: debit.id, totalPaise: 100000, yourSharePaise: 40000 }).returning();
  const [asha] = await db.insert(schema.splitParticipants).values({ splitId: split.id, personName: "Asha", expectedAmountPaise: 30000 }).returning();
  const [bala] = await db.insert(schema.splitParticipants).values({ splitId: split.id, personName: "Bala", expectedAmountPaise: 30000 }).returning();
  const [dev] = await db.insert(schema.owedExpenses).values({ userId, personName: "Dev", incurredDate: "2026-09-01", amountPaise: 25000, description: "tickets" }).returning();
  const [cat] = await db.insert(schema.categories).values({ userId, name: "Food", kind: "spend" }).returning();
  const events = () => db.select().from(schema.netEvents).where(eq(schema.netEvents.userId, userId)).orderBy(asc(schema.netEvents.createdAt));
  const legsOf = async (eventId: string) => db.select().from(schema.settlements).where(eq(schema.settlements.netEventId, eventId));

  console.log("validation");
  let r = await save({ eventDate: d, legs: [R(asha.id, 0, "offset"), R(bala.id, NaN, "offset")] });
  expect("only zero/NaN legs → 'At least one non-zero leg is required'", r.code === "INVALID" && r.message === "At least one non-zero leg is required", r);
  r = await save({ eventDate: d, legs: [R(asha.id, 1000, "bank")] });
  expect("bank receivable without inflow → INVALID", r.message === "Bank receivable legs require an inflow transaction", r);
  r = await save({ eventDate: d, legs: [P(dev.id, 1000, "bank")] });
  expect("payable with bank method → 'Payable legs must use offset method'", r.message === "Payable legs must use offset method", r);
  r = await save({ eventDate: d, inflowTransactionId: inflow.id, legs: [R(asha.id, 30000, "bank")] });
  expect("invariant mismatch → 'Net 300 does not match bank delta 600'", r.code === "INVALID" && r.message === "Net 300 does not match bank delta 600", r);
  r = await save({ eventDate: d, inflowTransactionId: inflow.id, legs: [R(asha.id, 40000, "bank"), R(bala.id, 20000, "bank")] });
  expect("receivable over outstanding → CONFLICT 'exceeds outstanding by 100'", r.code === "CONFLICT" && r.message === "Receivable leg exceeds outstanding by 100", r);
  r = await save({ eventDate: d, inflowTransactionId: crypto.randomUUID(), legs: [R(asha.id, 1000, "bank")] });
  expect("foreign inflow → FORBIDDEN", r.code === "FORBIDDEN", r);
  expect("…and no event was written", (await events()).length === 0);

  console.log("save / edit");
  r = await save({ eventDate: d, inflowTransactionId: inflow.id, note: "  first  ", legs: [R(asha.id, 30000, "bank"), R(bala.id, 30000, "bank")] });
  let evs = await events();
  expect("₹600 in, Asha + Bala bank → ok", r.ok, r);
  expect("event: inflow linked, note trimmed", evs.length === 1 && evs[0].inflowTransactionId === inflow.id && evs[0].note === "first", evs[0]);
  let legs = await legsOf(evs[0].id);
  expect("two bank legs carrying the inflow id", legs.length === 2 && legs.every((l) => l.method === "bank" && l.inflowTransactionId === inflow.id), legs);

  r = await save({ eventDate: d, legs: [R(asha.id, 5000, "offset"), P(dev.id, 5000)] });
  expect("Asha already settled → CONFLICT 'exceeds outstanding by 50'", r.message === "Receivable leg exceeds outstanding by 50", r);

  const firstId = evs[0].id;
  r = await save({ netEventId: firstId, eventDate: "2026-10-06", legs: [R(asha.id, 25000, "offset"), P(dev.id, 25000)] });
  evs = await events();
  legs = evs[0] ? await legsOf(evs[0].id) : [];
  expect("edit (own legs excluded from outstanding) → ok", r.ok, r);
  expect("…old event replaced by a new one", evs.length === 1 && evs[0].id !== firstId && evs[0].eventDate === "2026-10-06", evs);
  expect("…offset legs: Asha ₹250, Dev ₹250, no inflow", legs.length === 2 && legs.every((l) => l.method === "offset" && l.inflowTransactionId === null && l.amountPaise === 25000), legs);

  r = await save({ eventDate: d, note: "x".repeat(250), legs: [R(bala.id, 15000, "offset"), { kind: "payable", amountPaise: 15000, method: "offset", newPayable: { personName: " Chitra ", incurredDate: "2026-10-02", amountPaise: 20000, description: " lunch ", categoryId: cat.id, note: "  split lunch  " } }] });
  const [chitra] = await db.select().from(schema.owedExpenses).where(eq(schema.owedExpenses.personName, "Chitra"));
  evs = await events();
  expect("new payable to Chitra → ok", r.ok, r);
  expect("…payable: trimmed name/description/note, ₹200, category kept", chitra?.userId === userId && chitra.description === "lunch" && chitra.note === "split lunch" && chitra.amountPaise === 20000 && chitra.categoryId === cat.id, chitra);
  expect("…event note cut to 200 chars", evs.at(-1)?.note?.length === 200, evs.at(-1)?.note?.length);

  console.log("delete");
  const lastId = evs.at(-1)!.id;
  r = await call(deleteNetEventSpec, { netEventId: lastId });
  expect("delete → ok, event and its legs gone", r.ok && (await legsOf(lastId)).length === 0 && (await events()).length === 1, r);
  expect("…the payable it created stays", (await db.select().from(schema.owedExpenses).where(inArray(schema.owedExpenses.id, [chitra.id]))).length === 1);
  r = await call(deleteNetEventSpec, { netEventId: crypto.randomUUID() });
  expect("delete unknown event → FORBIDDEN", r.code === "FORBIDDEN", r);

  console.log("connection trouble");
  const failing = (msg: string) => new Proxy(db, { get: (t, k) => (k === "transaction" ? () => Promise.reject(new Error(msg)) : Reflect.get(t, k)) });
  r = await call(deleteNetEventSpec, { netEventId: (await events())[0].id }, layerFor(failing("Connection terminated due to connection timeout")));
  expect("timeout while deleting → UNAVAILABLE with the old message", r.code === "UNAVAILABLE" && r.message === "Database connection timed out while reversing. Please try again.", r);
  r = await call(deleteNetEventSpec, { netEventId: (await events())[0].id }, layerFor(failing("duplicate key value")));
  expect("any other DB error → INTERNAL", r.code === "INTERNAL", r);
} finally {
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  const left = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  console.log(`\ncleanup: test user ${left.length ? "STILL PRESENT" : "deleted (cascade)"}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  process.exit(failures.length === 0 ? 0 : 1);
}
