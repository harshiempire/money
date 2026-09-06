/**
 * Read-only data-integrity audit for reimbursement bookkeeping.
 *
 * Finds the bugs that have historically corrupted split/settlement/owed-expense
 * accounting (credits with unaccounted residuals, unbalanced splits,
 * over-settled participants, orphaned settlement rows, dangling person links)
 * so they can be triaged before any repair is attempted.
 *
 * STRICTLY READ-ONLY: only SELECTs. Never writes, updates, or deletes.
 *
 * Scoping follows scripts/backfill-persons.ts: no required arg — every user's
 * data is audited in one pass, with each finding labeled by owning user so a
 * multi-user database still reads clearly.
 *
 * Usage: bun run scripts/check-integrity.ts
 * Exit code: 0 when clean, 1 when any finding exists (or on error).
 */
import { sql } from "drizzle-orm";
import { db, schema } from "./lib/db";
import { formatPaise } from "../src/lib/format";

// ─── Preflight: make sure the schema this script depends on is migrated ──────

try {
  await db.select({ id: schema.settlements.id }).from(schema.settlements).limit(1);
  await db
    .select({
      residualDisposition: schema.transactions.residualDisposition,
      residualAcknowledgedPaise: schema.transactions.residualAcknowledgedPaise,
    })
    .from(schema.transactions)
    .limit(1);
  await db
    .select({
      sourceInflowTransactionId: schema.owedExpenses.sourceInflowTransactionId,
    })
    .from(schema.owedExpenses)
    .limit(1);
} catch (err) {
  const code =
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
      ? (err as { code: string }).code
      : null;
  if (code === "42P01" || code === "42703") {
    console.error(
      "Schema not migrated (missing table/column) — run migrations first:\n  bun run db:migrate",
    );
    process.exit(1);
  }
  throw err;
}

// ─── User labels (for attributing findings, not for filtering) ───────────────

const users = await db
  .select({ id: schema.users.id, email: schema.users.email })
  .from(schema.users);
const emailByUserId = new Map(users.map((u) => [u.id, u.email]));

function userLabel(userId: string | null | undefined): string {
  if (!userId) return "(unknown user)";
  return emailByUserId.get(userId) ?? userId;
}

// ─── Small helpers ─────────────────────────────────────────────────────────

const p = (n: unknown): number => Number(n ?? 0);
const rupees = (n: unknown): string => formatPaise(p(n));

let findingCount = 0;
const summary: { label: string; count: number }[] = [];

function section(label: string, count: number) {
  summary.push({ label, count });
  findingCount += count;
}

// ─── 1. Credits with a settlement residual ───────────────────────────────────
//
// A credit is fully explained once allocated + acknowledged (kept/written_off)
// + overpaymentPayables (owed_back) account for the whole amount — see
// src/domain/spend/net.ts for the shared "accountedPaise" identity. Only the
// unexplained remainder is a real finding.
//
// The overpayment sum is pulled via a correlated scalar subquery rather than
// a join: ${schema.owedExpenses} is already joined once (on settlement.owed_
// expense_id, to label cash-settled participants), and joining it a second
// time (on owed_expense.source_inflow_transaction_id) would fan out against
// the settlement rows already in the join and inflate sum(settlement.amount_
// paise). The subquery keeps its own scope, so it can't multiply anything.

type ResidualCreditRow = {
  userId: string;
  txnId: string;
  txnDate: string;
  description: string;
  creditPaise: unknown;
  allocatedPaise: unknown;
  acknowledgedPaise: unknown;
  overpaymentPaise: unknown;
  people: string;
}

const { rows: residualCredits } = await db.execute<ResidualCreditRow>(sql`
  select
    ${schema.moneyAccounts.userId} as "userId",
    ${schema.transactions.id} as "txnId",
    ${schema.transactions.txnDate} as "txnDate",
    ${schema.transactions.rawDescription} as "description",
    ${schema.transactions.amountPaise} as "creditPaise",
    coalesce(sum(${schema.settlements.amountPaise}), 0) as "allocatedPaise",
    coalesce(${schema.transactions.residualAcknowledgedPaise}, 0) as "acknowledgedPaise",
    coalesce(
      (select sum(${schema.owedExpenses.amountPaise}) from ${schema.owedExpenses}
       where ${schema.owedExpenses.sourceInflowTransactionId} = ${schema.transactions.id}),
      0
    ) as "overpaymentPaise",
    string_agg(
      distinct coalesce(${schema.splitParticipants.personName}, ${schema.owedExpenses.personName}, '(net event / unattributed)'),
      ', '
    ) as "people"
  from ${schema.transactions}
  join ${schema.moneyAccounts} on ${schema.moneyAccounts.id} = ${schema.transactions.accountId}
  join ${schema.settlements} on ${schema.settlements.inflowTransactionId} = ${schema.transactions.id}
  left join ${schema.splitParticipants} on ${schema.splitParticipants.id} = ${schema.settlements.splitParticipantId}
  left join ${schema.owedExpenses} on ${schema.owedExpenses.id} = ${schema.settlements.owedExpenseId}
  where ${schema.transactions.drCr} = 'credit'
  group by ${schema.moneyAccounts.userId}, ${schema.transactions.id}, ${schema.transactions.txnDate}, ${schema.transactions.rawDescription}, ${schema.transactions.amountPaise}, ${schema.transactions.residualAcknowledgedPaise}
  having (
    ${schema.transactions.amountPaise}
    - coalesce(sum(${schema.settlements.amountPaise}), 0)
    - coalesce(${schema.transactions.residualAcknowledgedPaise}, 0)
    - coalesce(
        (select sum(${schema.owedExpenses.amountPaise}) from ${schema.owedExpenses}
         where ${schema.owedExpenses.sourceInflowTransactionId} = ${schema.transactions.id}),
        0
      )
  ) <> 0
  order by ${schema.transactions.txnDate}
`);

// Grouped by the sign of the *unexplained* remainder (not raw allocated vs
// credit): a row can have allocated === credit exactly and still land here
// with a non-zero unexplained amount if acknowledged/owed-back double up on
// an already-allocated credit, so the split has to follow the same value the
// having clause filtered on or a row would silently vanish from both groups.
const unexplainedOf = (r: ResidualCreditRow): number =>
  p(r.creditPaise) - p(r.allocatedPaise) - p(r.acknowledgedPaise) - p(r.overpaymentPaise);

const underAllocated = residualCredits.filter((r) => unexplainedOf(r) > 0);
const overAllocated = residualCredits.filter((r) => unexplainedOf(r) < 0);

console.log("\n=== 1. Credits with a settlement residual ===");
if (residualCredits.length === 0) {
  console.log("  none");
} else {
  const printGroup = (label: string, rows: ResidualCreditRow[]) => {
    console.log(`  -- ${label} (${rows.length}) --`);
    for (const r of rows) {
      const credit = p(r.creditPaise);
      const allocated = p(r.allocatedPaise);
      const acknowledged = p(r.acknowledgedPaise);
      const owedBack = p(r.overpaymentPaise);
      const unexplained = unexplainedOf(r);
      console.log(
        `  txn ${r.txnId}  ${r.txnDate}  "${r.description}"  [${userLabel(r.userId)}]`,
      );
      console.log(
        `      credit ${rupees(credit)}  allocated ${rupees(allocated)}  acknowledged ${rupees(acknowledged)}  owed-back ${rupees(owedBack)}  unexplained ${rupees(unexplained)}  people: ${r.people}`,
      );
    }
  };
  if (underAllocated.length) printGroup("under-allocated", underAllocated);
  if (overAllocated.length) printGroup("over-allocated", overAllocated);
}
section("1. Credits with settlement residual", residualCredits.length);

// ─── 2. Splits that don't balance ────────────────────────────────────────────

type UnbalancedSplitRow = {
  userId: string;
  splitId: string;
  txnId: string;
  txnDate: string;
  description: string;
  totalPaise: unknown;
  yourSharePaise: unknown;
  participantsSum: unknown;
  participantCount: unknown;
}

const { rows: unbalancedSplits } = await db.execute<UnbalancedSplitRow>(sql`
  select
    ${schema.moneyAccounts.userId} as "userId",
    ${schema.splits.id} as "splitId",
    ${schema.transactions.id} as "txnId",
    ${schema.transactions.txnDate} as "txnDate",
    ${schema.transactions.rawDescription} as "description",
    ${schema.splits.totalPaise} as "totalPaise",
    ${schema.splits.yourSharePaise} as "yourSharePaise",
    coalesce(sum(${schema.splitParticipants.expectedAmountPaise}), 0) as "participantsSum",
    count(${schema.splitParticipants.id}) as "participantCount"
  from ${schema.splits}
  join ${schema.transactions} on ${schema.transactions.id} = ${schema.splits.transactionId}
  join ${schema.moneyAccounts} on ${schema.moneyAccounts.id} = ${schema.transactions.accountId}
  left join ${schema.splitParticipants} on ${schema.splitParticipants.splitId} = ${schema.splits.id}
  group by ${schema.moneyAccounts.userId}, ${schema.splits.id}, ${schema.transactions.id}, ${schema.transactions.txnDate}, ${schema.transactions.rawDescription}, ${schema.splits.totalPaise}, ${schema.splits.yourSharePaise}
  having ${schema.splits.totalPaise} <> ${schema.splits.yourSharePaise} + coalesce(sum(${schema.splitParticipants.expectedAmountPaise}), 0)
  order by ${schema.transactions.txnDate}
`);

console.log("\n=== 2. Splits that don't balance ===");
if (unbalancedSplits.length === 0) {
  console.log("  none");
} else {
  for (const r of unbalancedSplits) {
    const total = p(r.totalPaise);
    const yourShare = p(r.yourSharePaise);
    const participantsSum = p(r.participantsSum);
    const shortfall = total - (yourShare + participantsSum);
    console.log(
      `  split ${r.splitId}  txn ${r.txnId}  ${r.txnDate}  "${r.description}"  [${userLabel(r.userId)}]`,
    );
    console.log(
      `      total ${rupees(total)}  yourShare ${rupees(yourShare)}  participants(${p(r.participantCount)}) ${rupees(participantsSum)}  ${shortfall > 0 ? "shortfall" : "excess"} ${rupees(Math.abs(shortfall))}`,
    );
  }
}
section("2. Splits that don't balance", unbalancedSplits.length);

// ─── 3. Over-settled participants ────────────────────────────────────────────

type OverSettledParticipantRow = {
  userId: string;
  participantId: string;
  splitId: string;
  txnId: string;
  txnDate: string;
  description: string;
  personName: string;
  expectedPaise: unknown;
  settledPaise: unknown;
}

const { rows: overSettledParticipants } = await db.execute<OverSettledParticipantRow>(sql`
  select
    ${schema.moneyAccounts.userId} as "userId",
    ${schema.splitParticipants.id} as "participantId",
    ${schema.splits.id} as "splitId",
    ${schema.transactions.id} as "txnId",
    ${schema.transactions.txnDate} as "txnDate",
    ${schema.transactions.rawDescription} as "description",
    ${schema.splitParticipants.personName} as "personName",
    ${schema.splitParticipants.expectedAmountPaise} as "expectedPaise",
    coalesce(sum(${schema.settlements.amountPaise}), 0) as "settledPaise"
  from ${schema.splitParticipants}
  join ${schema.splits} on ${schema.splits.id} = ${schema.splitParticipants.splitId}
  join ${schema.transactions} on ${schema.transactions.id} = ${schema.splits.transactionId}
  join ${schema.moneyAccounts} on ${schema.moneyAccounts.id} = ${schema.transactions.accountId}
  join ${schema.settlements} on ${schema.settlements.splitParticipantId} = ${schema.splitParticipants.id}
  group by ${schema.moneyAccounts.userId}, ${schema.splitParticipants.id}, ${schema.splits.id}, ${schema.transactions.id}, ${schema.transactions.txnDate}, ${schema.transactions.rawDescription}, ${schema.splitParticipants.personName}, ${schema.splitParticipants.expectedAmountPaise}
  having coalesce(sum(${schema.settlements.amountPaise}), 0) > ${schema.splitParticipants.expectedAmountPaise}
  order by ${schema.transactions.txnDate}
`);

console.log("\n=== 3. Over-settled participants ===");
if (overSettledParticipants.length === 0) {
  console.log("  none");
} else {
  for (const r of overSettledParticipants) {
    const expected = p(r.expectedPaise);
    const settled = p(r.settledPaise);
    console.log(
      `  participant ${r.participantId} (${r.personName})  txn ${r.txnId}  ${r.txnDate}  "${r.description}"  [${userLabel(r.userId)}]`,
    );
    console.log(
      `      expected ${rupees(expected)}  settled ${rupees(settled)}  over by ${rupees(settled - expected)}`,
    );
  }
}
section("3. Over-settled participants", overSettledParticipants.length);

// ─── 4. Over-settled owed expenses ───────────────────────────────────────────

type OverSettledOwedExpenseRow = {
  userId: string;
  owedExpenseId: string;
  incurredDate: string;
  description: string;
  personName: string;
  amountPaise: unknown;
  settledPaise: unknown;
}

const { rows: overSettledOwedExpenses } = await db.execute<OverSettledOwedExpenseRow>(sql`
  select
    ${schema.owedExpenses.userId} as "userId",
    ${schema.owedExpenses.id} as "owedExpenseId",
    ${schema.owedExpenses.incurredDate} as "incurredDate",
    ${schema.owedExpenses.description} as "description",
    ${schema.owedExpenses.personName} as "personName",
    ${schema.owedExpenses.amountPaise} as "amountPaise",
    coalesce(sum(${schema.settlements.amountPaise}), 0) as "settledPaise"
  from ${schema.owedExpenses}
  join ${schema.settlements} on ${schema.settlements.owedExpenseId} = ${schema.owedExpenses.id}
  group by ${schema.owedExpenses.userId}, ${schema.owedExpenses.id}, ${schema.owedExpenses.incurredDate}, ${schema.owedExpenses.description}, ${schema.owedExpenses.personName}, ${schema.owedExpenses.amountPaise}
  having coalesce(sum(${schema.settlements.amountPaise}), 0) > ${schema.owedExpenses.amountPaise}
  order by ${schema.owedExpenses.incurredDate}
`);

console.log("\n=== 4. Over-settled owed expenses ===");
if (overSettledOwedExpenses.length === 0) {
  console.log("  none");
} else {
  for (const r of overSettledOwedExpenses) {
    const amount = p(r.amountPaise);
    const settled = p(r.settledPaise);
    console.log(
      `  owed_expense ${r.owedExpenseId} (${r.personName})  ${r.incurredDate}  "${r.description}"  [${userLabel(r.userId)}]`,
    );
    console.log(
      `      amount ${rupees(amount)}  settled ${rupees(settled)}  over by ${rupees(settled - amount)}`,
    );
  }
}
section("4. Over-settled owed expenses", overSettledOwedExpenses.length);

// ─── 5. Orphaned settlement rows ─────────────────────────────────────────────

type OrphanNoSourceRow = {
  userId: string | null;
  settlementId: string;
  createdAt: string;
  amountPaise: unknown;
  method: string;
  note: string | null;
  personName: string | null;
}

const { rows: orphanNoSource } = await db.execute<OrphanNoSourceRow>(sql`
  select
    coalesce(${schema.moneyAccounts.userId}, ${schema.owedExpenses.userId}) as "userId",
    ${schema.settlements.id} as "settlementId",
    ${schema.settlements.createdAt} as "createdAt",
    ${schema.settlements.amountPaise} as "amountPaise",
    ${schema.settlements.method} as "method",
    ${schema.settlements.note} as "note",
    coalesce(${schema.splitParticipants.personName}, ${schema.owedExpenses.personName}) as "personName"
  from ${schema.settlements}
  left join ${schema.splitParticipants} on ${schema.splitParticipants.id} = ${schema.settlements.splitParticipantId}
  left join ${schema.splits} on ${schema.splits.id} = ${schema.splitParticipants.splitId}
  left join ${schema.transactions} on ${schema.transactions.id} = ${schema.splits.transactionId}
  left join ${schema.moneyAccounts} on ${schema.moneyAccounts.id} = ${schema.transactions.accountId}
  left join ${schema.owedExpenses} on ${schema.owedExpenses.id} = ${schema.settlements.owedExpenseId}
  where (
      (${schema.settlements.method} = 'bank' and ${schema.settlements.inflowTransactionId} is null)
      or (${schema.settlements.method} = 'offset' and ${schema.settlements.netEventId} is null)
    )
  order by ${schema.settlements.createdAt}
`);

type OrphanNoTargetRow = {
  userId: string | null;
  settlementId: string;
  createdAt: string;
  amountPaise: unknown;
  method: string;
  note: string | null;
  txnDate: string | null;
  description: string | null;
}

const { rows: orphanNoTarget } = await db.execute<OrphanNoTargetRow>(sql`
  select
    ${schema.moneyAccounts.userId} as "userId",
    ${schema.settlements.id} as "settlementId",
    ${schema.settlements.createdAt} as "createdAt",
    ${schema.settlements.amountPaise} as "amountPaise",
    ${schema.settlements.method} as "method",
    ${schema.settlements.note} as "note",
    ${schema.transactions.txnDate} as "txnDate",
    ${schema.transactions.rawDescription} as "description"
  from ${schema.settlements}
  left join ${schema.transactions} on ${schema.transactions.id} = ${schema.settlements.inflowTransactionId}
  left join ${schema.moneyAccounts} on ${schema.moneyAccounts.id} = ${schema.transactions.accountId}
  where ${schema.settlements.splitParticipantId} is null
    and ${schema.settlements.owedExpenseId} is null
  order by ${schema.settlements.createdAt}
`);

console.log("\n=== 5. Orphaned settlement rows ===");
// Cash settlements legitimately have neither an inflow txn nor a net event —
// only bank rows need an inflow, and only offset rows need a net event.
console.log(`  -- bank without inflow / offset without net-event (${orphanNoSource.length}) --`);
if (orphanNoSource.length === 0) {
  console.log("  none");
} else {
  for (const r of orphanNoSource) {
    console.log(
      `  settlement ${r.settlementId}  ${r.createdAt}  ${rupees(p(r.amountPaise))}  method=${r.method}${r.personName ? `  person=${r.personName}` : ""}${r.note ? `  note=${JSON.stringify(r.note)}` : ""}  [${userLabel(r.userId)}]`,
    );
  }
}
console.log(`  -- no split_participant and no owed_expense target (${orphanNoTarget.length}) --`);
if (orphanNoTarget.length === 0) {
  console.log("  none");
} else {
  for (const r of orphanNoTarget) {
    console.log(
      `  settlement ${r.settlementId}  ${r.createdAt}  ${rupees(p(r.amountPaise))}  method=${r.method}${r.description ? `  inflow="${r.description}" (${r.txnDate})` : ""}${r.note ? `  note=${JSON.stringify(r.note)}` : ""}  [${userLabel(r.userId)}]`,
    );
  }
}
section("5a. Orphaned settlements (bank w/o inflow, offset w/o net-event)", orphanNoSource.length);
section("5b. Orphaned settlements (no target)", orphanNoTarget.length);

// ─── 6. Dangling person links ────────────────────────────────────────────────

type DanglingParticipantRow = {
  userId: string;
  participantId: string;
  txnId: string;
  txnDate: string;
  description: string;
  personName: string;
  expectedPaise: unknown;
  matchedPersonId: string;
}

const { rows: danglingParticipants } = await db.execute<DanglingParticipantRow>(sql`
  select
    ${schema.moneyAccounts.userId} as "userId",
    ${schema.splitParticipants.id} as "participantId",
    ${schema.transactions.id} as "txnId",
    ${schema.transactions.txnDate} as "txnDate",
    ${schema.transactions.rawDescription} as "description",
    ${schema.splitParticipants.personName} as "personName",
    ${schema.splitParticipants.expectedAmountPaise} as "expectedPaise",
    ${schema.persons.id} as "matchedPersonId"
  from ${schema.splitParticipants}
  join ${schema.splits} on ${schema.splits.id} = ${schema.splitParticipants.splitId}
  join ${schema.transactions} on ${schema.transactions.id} = ${schema.splits.transactionId}
  join ${schema.moneyAccounts} on ${schema.moneyAccounts.id} = ${schema.transactions.accountId}
  join ${schema.persons} on ${schema.persons.userId} = ${schema.moneyAccounts.userId}
    and lower(${schema.persons.name}) = lower(${schema.splitParticipants.personName})
  where ${schema.splitParticipants.personId} is null
  order by ${schema.transactions.txnDate}
`);

type DanglingOwedExpenseRow = {
  userId: string;
  owedExpenseId: string;
  incurredDate: string;
  description: string;
  personName: string;
  amountPaise: unknown;
  matchedPersonId: string;
}

const { rows: danglingOwedExpenses } = await db.execute<DanglingOwedExpenseRow>(sql`
  select
    ${schema.owedExpenses.userId} as "userId",
    ${schema.owedExpenses.id} as "owedExpenseId",
    ${schema.owedExpenses.incurredDate} as "incurredDate",
    ${schema.owedExpenses.description} as "description",
    ${schema.owedExpenses.personName} as "personName",
    ${schema.owedExpenses.amountPaise} as "amountPaise",
    ${schema.persons.id} as "matchedPersonId"
  from ${schema.owedExpenses}
  join ${schema.persons} on ${schema.persons.userId} = ${schema.owedExpenses.userId}
    and lower(${schema.persons.name}) = lower(${schema.owedExpenses.personName})
  where ${schema.owedExpenses.personId} is null
  order by ${schema.owedExpenses.incurredDate}
`);

console.log("\n=== 6. Dangling person links (person_id NULL but a matching person exists) ===");
console.log(`  -- split_participant (${danglingParticipants.length}) --`);
if (danglingParticipants.length === 0) {
  console.log("  none");
} else {
  for (const r of danglingParticipants) {
    console.log(
      `  participant ${r.participantId} (${r.personName} -> person ${r.matchedPersonId})  txn ${r.txnId}  ${r.txnDate}  "${r.description}"  expected ${rupees(p(r.expectedPaise))}  [${userLabel(r.userId)}]`,
    );
  }
}
console.log(`  -- owed_expense (${danglingOwedExpenses.length}) --`);
if (danglingOwedExpenses.length === 0) {
  console.log("  none");
} else {
  for (const r of danglingOwedExpenses) {
    console.log(
      `  owed_expense ${r.owedExpenseId} (${r.personName} -> person ${r.matchedPersonId})  ${r.incurredDate}  "${r.description}"  amount ${rupees(p(r.amountPaise))}  [${userLabel(r.userId)}]`,
    );
  }
}
section("6a. Split participants with dangling person link", danglingParticipants.length);
section("6b. Owed expenses with dangling person link", danglingOwedExpenses.length);

// ─── 7. Reimbursement credits with nothing recorded against them ─────────────
// Check 1 starts from settlement rows, so a credit filed under a
// "reimbursement" category that never got a settlement, a leftover decision,
// or an overpayment payable is invisible to it. Surface those here.

type UnsettledReimbursementRow = {
  userId: string;
  txnId: string;
  txnDate: string;
  description: string;
  creditPaise: unknown;
  categoryName: string;
};

const { rows: unsettledReimbursements } = await db.execute<UnsettledReimbursementRow>(sql`
  select
    ${schema.moneyAccounts.userId} as "userId",
    ${schema.transactions.id} as "txnId",
    ${schema.transactions.txnDate} as "txnDate",
    ${schema.transactions.rawDescription} as "description",
    ${schema.transactions.amountPaise} as "creditPaise",
    ${schema.categories.name} as "categoryName"
  from ${schema.transactions}
  join ${schema.moneyAccounts} on ${schema.moneyAccounts.id} = ${schema.transactions.accountId}
  join ${schema.categories} on ${schema.categories.id} = ${schema.transactions.categoryId}
  where ${schema.transactions.drCr} = 'credit'
    and ${schema.transactions.isTransfer} = false
    and ${schema.categories.kind} = 'reimbursement'
    and ${schema.transactions.residualDisposition} is null
    and not exists (
      select 1 from ${schema.settlements}
      where ${schema.settlements.inflowTransactionId} = ${schema.transactions.id}
    )
    and not exists (
      select 1 from ${schema.owedExpenses}
      where ${schema.owedExpenses.sourceInflowTransactionId} = ${schema.transactions.id}
    )
  order by ${schema.transactions.txnDate}
`);

console.log("\n=== 7. Reimbursement-category credits with no settlement recorded ===");
if (unsettledReimbursements.length === 0) {
  console.log("  none");
} else {
  for (const r of unsettledReimbursements) {
    console.log(
      `  txn ${r.txnId}  ${r.txnDate}  "${r.description}"  credit ${rupees(r.creditPaise)}  category=${r.categoryName}  [${userLabel(r.userId)}]`,
    );
  }
}
section("7. Reimbursement-category credits with no settlement", unsettledReimbursements.length);

// ─── Summary ──────────────────────────────────────────────────────────────

console.log("\n=== SUMMARY ===");
for (const { label, count } of summary) {
  console.log(`  ${String(count).padStart(4)}  ${label}`);
}
console.log(`  ${"-".repeat(4)}`);
console.log(`  ${String(findingCount).padStart(4)}  TOTAL`);

if (findingCount === 0) {
  console.log("\nNo integrity issues found.");
  process.exit(0);
} else {
  console.log(`\n${findingCount} integrity issue(s) found.`);
  process.exit(1);
}
