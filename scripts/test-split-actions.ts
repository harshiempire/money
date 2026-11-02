/**
 * Integration check for the split / settlement actions against a real
 * Postgres — the Neon `local-dev` branch ONLY. Never production.
 *
 * Creates a throwaway user with one account, a ₹1,000 payment and a ₹600
 * credit, runs every action through the same runAction() path the server
 * uses (decode → handler → ActionResult), asserts both the result and the
 * resulting rows, then deletes the user (everything cascades).
 *
 * Usage (DATABASE_URL must point at local-dev; .env's prod URL is refused):
 *   DATABASE_URL="$(cat ~/.money-scratch/local-dev/dburl)" \
 *     bun --conditions=react-server --preload ~/.money-scratch/neon-dns.cjs \
 *     run scripts/test-split-actions.ts
 */
// Type-only (erased at runtime), so nothing loads before the URL guard below.
import type { Layer as LayerType } from "effect";

const { requireLocalDevDatabase } = await import("./lib/local-dev-guard");
requireLocalDevDatabase();

const { eq, inArray } = await import("drizzle-orm");
const { Effect, Layer } = await import("effect");
const { db, schema } = await import("../src/db");
const { runAction } = await import("../src/lib/action/core");
const { Unauthenticated } = await import("../src/lib/action/errors");
const { CurrentUser, Db } = await import("../src/lib/action/services");
const specs = await import("../src/app/transactions/split-handlers");

type Result = { ok: boolean; code?: string; message?: string; field?: string };

const userId = crypto.randomUUID();
const email = `split-actions-test+${userId}@example.invalid`;
const failures: string[] = [];
let passed = 0;

function expect(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const asUser = Layer.merge(Layer.succeed(CurrentUser, { id: userId, email }), Layer.succeed(Db, db));
const signedOut = Layer.merge(Layer.effectContext(Effect.fail(new Unauthenticated())), Layer.succeed(Db, db));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (spec: any, input: unknown, layer: LayerType.Layer<any, any> = asUser) =>
  runAction(spec, input, { name: "test", layer, log: (m) => console.log("    [defect log]", m.split("\n")[0]) }) as Promise<Result>;

const state = async (debitId: string, creditId: string) => {
  const [split] = await db.select().from(schema.splits).where(eq(schema.splits.transactionId, debitId));
  const participants = split
    ? await db.select().from(schema.splitParticipants).where(eq(schema.splitParticipants.splitId, split.id))
    : [];
  const settlements = await db.select().from(schema.settlements).where(eq(schema.settlements.inflowTransactionId, creditId));
  const owed = await db.select().from(schema.owedExpenses).where(eq(schema.owedExpenses.sourceInflowTransactionId, creditId));
  const [credit] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, creditId));
  const byName = (id: string | null) => participants.find((p) => p.id === id)?.personName;
  return {
    split,
    participants: participants.map((p) => `${p.personName}:${p.expectedAmountPaise}`).sort(),
    settlements: settlements.map((s) => `${byName(s.splitParticipantId)}:${s.amountPaise}`).sort(),
    owed: owed.map((o) => `${o.personName}:${o.amountPaise}`),
    disposition: `${credit.residualDisposition}:${credit.residualAcknowledgedPaise}`,
    participantIds: Object.fromEntries(participants.map((p) => [p.personName, p.id])),
  };
};

try {
  // ── fixture ────────────────────────────────────────────────────────────────
  await db.insert(schema.users).values({ id: userId, email, name: "split-actions test" });
  const [account] = await db
    .insert(schema.moneyAccounts)
    .values({ userId, name: "Test", bank: "bob", openingBalancePaise: 0, openingDate: "2026-01-01" })
    .returning();
  const base = { accountId: account.id, txnDate: "2026-10-01", channel: "upi" as const, rawDescription: "test" };
  const [debit] = await db.insert(schema.transactions).values({ ...base, amountPaise: 100000, drCr: "debit", refId: "T-DEBIT" }).returning();
  const [credit] = await db.insert(schema.transactions).values({ ...base, amountPaise: 60000, drCr: "credit", refId: "T-CREDIT" }).returning();
  console.log(`fixture: user ${userId.slice(0, 8)}…, ₹1,000 debit, ₹600 credit\n`);

  // ── auth & input ───────────────────────────────────────────────────────────
  console.log("auth / input");
  let r = await call(specs.createSplitSpec, { transactionId: debit.id }, signedOut);
  expect("no session → UNAUTHENTICATED", r.code === "UNAUTHENTICATED", r);
  r = await call(specs.deleteSplitSpec, { transactionId: crypto.randomUUID() });
  expect("someone else's / unknown transaction → FORBIDDEN", r.code === "FORBIDDEN", r);
  r = await call(specs.createSplitSpec, { transactionId: debit.id, totalPaise: 100000, yourSharePaise: 0, note: null, participants: "nope" });
  expect("malformed participants → INVALID on field 'participants'", r.code === "INVALID" && r.field === "participants", r);

  // ── createSplit ────────────────────────────────────────────────────────────
  console.log("createSplit");
  const participants = [
    { personName: "Asha", expectedAmountPaise: 30000 },
    { personName: "Bala", expectedAmountPaise: 30000 },
  ];
  r = await call(specs.createSplitSpec, { transactionId: credit.id, totalPaise: 60000, yourSharePaise: 0, note: null, participants: [{ personName: "Asha", expectedAmountPaise: 60000 }] });
  expect("split on a credit → INVALID 'Only a payment you made can be split.'", r.code === "INVALID" && r.message === "Only a payment you made can be split.", r);
  r = await call(specs.createSplitSpec, { transactionId: debit.id, totalPaise: 90000, yourSharePaise: 30000, note: null, participants });
  expect("total ≠ transaction amount → INVALID with validator message", r.code === "INVALID" && !!r.message, r);
  let s = await state(debit.id, credit.id);
  expect("…and nothing was written", !s.split, s);
  r = await call(specs.createSplitSpec, { transactionId: debit.id, totalPaise: 100000, yourSharePaise: 40000, note: null, participants: [{ personName: "Asha", expectedAmountPaise: 30000 }, { personName: " asha", expectedAmountPaise: 30000 }] });
  s = await state(debit.id, credit.id);
  expect("same person twice ('Asha' / ' asha') → INVALID", r.code === "INVALID" && r.message === "asha appears twice in this split. Each person may only have one share.", r);
  expect("…and nothing was written", !s.split, s);

  r = await call(specs.createSplitSpec, { transactionId: debit.id, totalPaise: 100000, yourSharePaise: 40000, note: "dinner", participants });
  s = await state(debit.id, credit.id);
  expect("valid split → ok", r.ok, r);
  expect("split row: total 100000, your share 40000, note 'dinner'", s.split?.totalPaise === 100000 && s.split?.yourSharePaise === 40000 && s.split?.note === "dinner", s.split);
  expect("participants Asha:30000, Bala:30000", JSON.stringify(s.participants) === JSON.stringify(["Asha:30000", "Bala:30000"]), s.participants);
  const persons = await db.select().from(schema.persons).where(eq(schema.persons.userId, userId));
  expect("persons Asha + Bala created and linked", persons.length === 2, persons.map((p) => p.name));

  // ── recordSettlement ───────────────────────────────────────────────────────
  console.log("recordSettlement");
  const ids = s.participantIds as Record<string, string>;
  r = await call(specs.recordSettlementSpec, { inflowTransactionId: debit.id, allocations: [] });
  expect("settling against a payment → INVALID (validateSettlementSource)", r.code === "INVALID" && !!r.message, r);
  r = await call(specs.recordSettlementSpec, { inflowTransactionId: credit.id, allocations: [{ splitParticipantId: ids.Asha, amountPaise: -5 }] });
  expect("negative allocation → INVALID (cleanAllocations)", r.code === "INVALID" && !!r.message, r);

  r = await call(specs.recordSettlementSpec, {
    inflowTransactionId: credit.id,
    allocations: [{ splitParticipantId: ids.Asha, amountPaise: 30000 }, { splitParticipantId: ids.Bala, amountPaise: 20000 }],
    residual: { kind: "kept", note: null },
  });
  s = await state(debit.id, credit.id);
  expect("Asha 300 + Bala 200, ₹100 kept → ok", r.ok, r);
  expect("settlements Asha:30000, Bala:20000", JSON.stringify(s.settlements) === JSON.stringify(["Asha:30000", "Bala:20000"]), s.settlements);
  expect("credit disposition kept:10000", s.disposition === "kept:10000", s.disposition);

  r = await call(specs.recordSettlementSpec, {
    inflowTransactionId: credit.id,
    allocations: [{ splitParticipantId: ids.Asha, amountPaise: 10000 }],
    residual: { kind: "owed_back", note: null },
  });
  s = await state(debit.id, credit.id);
  expect("owed_back without a name → INVALID 'A person name is required…'", r.code === "INVALID" && r.message === "A person name is required to record an overpayment as owed back.", r);
  expect("…and the transaction rolled back: settlements unchanged", JSON.stringify(s.settlements) === JSON.stringify(["Asha:30000", "Bala:20000"]), s.settlements);
  expect("…and disposition still kept:10000", s.disposition === "kept:10000", s.disposition);

  r = await call(specs.recordSettlementSpec, { inflowTransactionId: credit.id, allocations: [{ splitParticipantId: ids.Asha, amountPaise: 40000 }] });
  expect("over-allocating Asha → CONFLICT with exact message", r.code === "CONFLICT" && r.message === "Allocation of ₹400.00 to Asha exceeds their outstanding balance of ₹300.00.", r);

  r = await call(specs.recordSettlementSpec, {
    inflowTransactionId: credit.id,
    allocations: [{ splitParticipantId: ids.Asha, amountPaise: 30000 }],
    residual: { kind: "owed_back", personName: "  Chitra  ", note: "refund" },
  });
  s = await state(debit.id, credit.id);
  expect("Asha 300, ₹300 owed back to 'Chitra' → ok", r.ok, r);
  expect("settlements now just Asha:30000", JSON.stringify(s.settlements) === JSON.stringify(["Asha:30000"]), s.settlements);
  expect("payable Chitra:30000 (name trimmed)", JSON.stringify(s.owed) === JSON.stringify(["Chitra:30000"]), s.owed);
  expect("disposition cleared (null:null)", s.disposition === "null:null", s.disposition);

  // ── createSplit edit guard ─────────────────────────────────────────────────
  console.log("createSplit (edit)");
  r = await call(specs.createSplitSpec, { transactionId: debit.id, totalPaise: 100000, yourSharePaise: 70000, note: null, participants: [{ id: ids.Bala, personName: "Bala", expectedAmountPaise: 30000 }] });
  s = await state(debit.id, credit.id);
  expect("removing settled Asha → CONFLICT", r.code === "CONFLICT" && !!r.message, r);
  expect("…participants unchanged", JSON.stringify(s.participants) === JSON.stringify(["Asha:30000", "Bala:30000"]), s.participants);
  r = await call(specs.createSplitSpec, { transactionId: debit.id, totalPaise: 100000, yourSharePaise: 40000, note: null, participants: [{ id: ids.Asha, personName: "Asha", expectedAmountPaise: 30000 }, { id: crypto.randomUUID(), personName: "Bala", expectedAmountPaise: 30000 }] });
  expect("foreign participant id → INVALID", r.code === "INVALID" && !!r.message, r);
  r = await call(specs.createSplitSpec, { transactionId: debit.id, totalPaise: 100000, yourSharePaise: 40000, note: "edited", participants: [{ id: ids.Asha, personName: "Asha", expectedAmountPaise: 30000 }, { id: ids.Bala, personName: "Bala", expectedAmountPaise: 30000 }] });
  s = await state(debit.id, credit.id);
  expect("editing the note while keeping both → ok, same rows", r.ok && s.split?.note === "edited" && s.participantIds.Asha === ids.Asha, { r, note: s.split?.note });

  // ── clearSettlement ────────────────────────────────────────────────────────
  console.log("clearSettlement");
  r = await call(specs.clearSettlementSpec, { inflowTransactionId: credit.id });
  s = await state(debit.id, credit.id);
  expect("clear → ok", r.ok, r);
  expect("…settlements, payable and disposition all gone", s.settlements.length === 0 && s.owed.length === 0 && s.disposition === "null:null", s);

  // ── deleteSplit ────────────────────────────────────────────────────────────
  console.log("deleteSplit");
  await call(specs.recordSettlementSpec, { inflowTransactionId: credit.id, allocations: [{ splitParticipantId: ids.Bala, amountPaise: 30000 }], residual: { kind: "written_off", note: null } });
  s = await state(debit.id, credit.id);
  expect("(setup) Bala settled, ₹300 written off", s.disposition === "written_off:30000", s.disposition);
  r = await call(specs.deleteSplitSpec, { transactionId: debit.id });
  s = await state(debit.id, credit.id);
  expect("delete → ok", r.ok, r);
  expect("…split, participants and their settlements gone", !s.split && s.settlements.length === 0, s);
  expect("…credit's acknowledgement reset to null:null", s.disposition === "null:null", s.disposition);
  r = await call(specs.deleteSplitSpec, { transactionId: debit.id });
  expect("deleting again (nothing there) → ok", r.ok, r);
} finally {
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  const [left] = await db.select().from(schema.users).where(inArray(schema.users.id, [userId]));
  console.log(`\ncleanup: test user ${left ? "STILL PRESENT" : "deleted (cascade)"}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  process.exit(failures.length === 0 ? 0 : 1);
}
